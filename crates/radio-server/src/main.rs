use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        State,
    },
    response::IntoResponse,
    routing::get,
    Json, Router,
};
use futures_util::{SinkExt, StreamExt};
use radio_core::{
    encode_audio_packet, AudioCodec, AudioPacketHeader, ControlMessage, DEFAULT_PACKET_FRAMES,
    DEFAULT_TARGET_LATENCY_MS, SAMPLE_RATE_HZ,
};
use serde::Serialize;
use std::{
    collections::HashMap,
    fs::File,
    net::SocketAddr,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Mutex,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use symphonia::core::{
    audio::{AudioBufferRef, SampleBuffer},
    codecs::DecoderOptions,
    errors::Error as SymphoniaError,
    formats::FormatOptions,
    io::MediaSourceStream,
    meta::MetadataOptions,
    probe::Hint,
};
use tokio::sync::{broadcast, mpsc};
use tower_http::{
    services::ServeDir,
    trace::{DefaultMakeSpan, TraceLayer},
};
use tracing::{info, warn};

struct AppState {
    control_tx: broadcast::Sender<ControlMessage>,
    stream_started_at_ns: i128,
    source: Arc<AudioSource>,
    next_client_id: AtomicUsize,
    clients: Mutex<HashMap<usize, ClientDiagnostic>>,
    connected_clients: AtomicUsize,
    active_audio_sockets: AtomicUsize,
}

struct AudioSource {
    path: PathBuf,
    title: String,
    artist: Option<String>,
    samples: Vec<f32>,
    frame_count: u64,
    channel_count: u16,
    sample_rate_hz: u32,
}

#[derive(Clone, Copy)]
enum AudienceCounterKind {
    Control { client_id: usize },
    Audio,
}

struct AudienceCounterGuard {
    state: Arc<AppState>,
    kind: AudienceCounterKind,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ClientDiagnostic {
    id: usize,
    device_id: Option<String>,
    user_agent: Option<String>,
    connected_at_ms: f64,
    last_seen_ms: f64,
    rtt_ms: Option<f64>,
    clock_offset_ms: Option<f64>,
    buffer_ms: Option<f64>,
    playback_error_ms: Option<f64>,
    playback_error_p95_ms: Option<f64>,
    playback_error_max_ms: Option<f64>,
    resample_ratio: Option<f64>,
    underruns: u64,
    late_drops: u64,
    resyncs: u64,
    device_output_offset_ms: Option<f64>,
}

struct ClientStatusPatch {
    rtt_ms: f64,
    clock_offset_ms: f64,
    buffer_ms: f64,
    playback_error_ms: f64,
    playback_error_p95_ms: Option<f64>,
    playback_error_max_ms: Option<f64>,
    resample_ratio: f64,
    underruns: u64,
    late_drops: Option<u64>,
    resyncs: Option<u64>,
    device_output_offset_ms: Option<f64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HealthResponse {
    ok: bool,
    server_time_ms: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ClientDiagnosticsResponse {
    server_time_ms: f64,
    clients: Vec<ClientDiagnostic>,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "radio_server=info,tower_http=info".into()),
        )
        .init();

    let (control_tx, _) = broadcast::channel(128);
    let source = Arc::new(load_first_track(Path::new("media/tracks"))?);
    info!(
        path = %source.path.display(),
        frames = source.frame_count,
        sample_rate_hz = source.sample_rate_hz,
        channel_count = source.channel_count,
        "loaded audio source"
    );

    let state = Arc::new(AppState {
        control_tx,
        stream_started_at_ns: unix_time_ns(),
        source,
        next_client_id: AtomicUsize::new(1),
        clients: Mutex::new(HashMap::new()),
        connected_clients: AtomicUsize::new(0),
        active_audio_sockets: AtomicUsize::new(0),
    });

    let app = Router::new()
        .route("/health", get(health))
        .route("/api/clients", get(client_diagnostics))
        .route("/ws/control", get(control_ws))
        .route("/ws/audio", get(audio_ws))
        .fallback_service(ServeDir::new("apps/web/dist"))
        .layer(
            TraceLayer::new_for_http()
                .make_span_with(DefaultMakeSpan::default().include_headers(true)),
        )
        .with_state(state);

    let addr: SocketAddr = std::env::var("RADIO_LISTEN_ADDR")
        .unwrap_or_else(|_| "127.0.0.1:3000".to_string())
        .parse()?;

    info!(%addr, "starting radio server");
    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await?;

    Ok(())
}

async fn health() -> Json<HealthResponse> {
    Json(HealthResponse {
        ok: true,
        server_time_ms: unix_time_ms(),
    })
}

async fn client_diagnostics(State(state): State<Arc<AppState>>) -> Json<ClientDiagnosticsResponse> {
    Json(state.client_diagnostics())
}

async fn control_ws(State(state): State<Arc<AppState>>, ws: WebSocketUpgrade) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_control_socket(socket, state))
}

async fn audio_ws(State(state): State<Arc<AppState>>, ws: WebSocketUpgrade) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_audio_socket(socket, state))
}

async fn handle_control_socket(socket: WebSocket, state: Arc<AppState>) {
    let (mut sender, mut receiver) = socket.split();
    let counter_guard = state.track_control_connection();
    let client_id = counter_guard.client_id();
    let mut control_rx = state.control_tx.subscribe();
    let (outbound_tx, mut outbound_rx) = mpsc::channel::<ControlMessage>(32);

    let session = ControlMessage::SessionConfig {
        target_latency_ms: DEFAULT_TARGET_LATENCY_MS,
        sample_rate_hz: SAMPLE_RATE_HZ,
        scene_version: 0,
    };

    for message in [
        session,
        state.track_info_message(),
        state.audience_stats_message(),
    ] {
        if !send_control_message(&mut sender, &message).await {
            return;
        }
    }

    let forward_task = tokio::spawn(async move {
        loop {
            tokio::select! {
                Some(message) = outbound_rx.recv() => {
                    if !send_control_message(&mut sender, &message).await {
                        break;
                    }
                }
                Ok(message) = control_rx.recv() => {
                    if !send_control_message(&mut sender, &message).await {
                        break;
                    }
                }
            }
        }
    });

    while let Some(Ok(message)) = receiver.next().await {
        match message {
            Message::Text(text) => {
                handle_control_message(&state, client_id, &outbound_tx, &text).await
            }
            Message::Close(_) => break,
            _ => {}
        }
    }

    forward_task.abort();
}

async fn handle_control_message(
    state: &AppState,
    client_id: usize,
    outbound_tx: &mpsc::Sender<ControlMessage>,
    text: &str,
) {
    match serde_json::from_str::<ControlMessage>(text) {
        Ok(ControlMessage::ClockPing {
            client_send_time_ms,
        }) => {
            let server_receive_time_ms = unix_time_ms();
            let response = ControlMessage::ClockPong {
                client_send_time_ms,
                server_receive_time_ms,
                server_send_time_ms: unix_time_ms(),
            };

            if outbound_tx.send(response).await.is_err() {
                warn!("failed to send clock pong");
            }
        }
        Ok(ControlMessage::Hello {
            device_id,
            user_agent,
        }) => {
            state.update_client_identity(client_id, device_id.clone(), user_agent);
            info!(%device_id, "device connected");
        }
        Ok(ControlMessage::ClientStatus {
            rtt_ms,
            clock_offset_ms,
            buffer_ms,
            playback_error_ms,
            playback_error_p95_ms,
            playback_error_max_ms,
            resample_ratio,
            underruns,
            late_drops,
            resyncs,
            device_output_offset_ms,
        }) => {
            state.update_client_status(
                client_id,
                ClientStatusPatch {
                    rtt_ms,
                    clock_offset_ms,
                    buffer_ms,
                    playback_error_ms,
                    playback_error_p95_ms,
                    playback_error_max_ms,
                    resample_ratio,
                    underruns,
                    late_drops,
                    resyncs,
                    device_output_offset_ms,
                },
            );
        }
        Ok(ControlMessage::TrackInfo { .. } | ControlMessage::AudienceStats { .. }) => {}
        Ok(other) => {
            info!(?other, "received control message");
        }
        Err(error) => {
            warn!(%error, "invalid control message");
        }
    }
}

async fn send_control_message(
    sender: &mut futures_util::stream::SplitSink<WebSocket, Message>,
    message: &ControlMessage,
) -> bool {
    let Ok(payload) = serde_json::to_string(message) else {
        return true;
    };
    sender.send(Message::Text(payload.into())).await.is_ok()
}

async fn handle_audio_socket(mut socket: WebSocket, state: Arc<AppState>) {
    let _counter_guard = state.track_audio_socket();
    let frame_count = DEFAULT_PACKET_FRAMES;
    let tick = Duration::from_millis(20);
    let mut interval = tokio::time::interval(tick);
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

    let mut sample_index = current_stream_sample_index(state.stream_started_at_ns);
    sample_index -= sample_index % frame_count as u64;
    let mut seq = sample_index / frame_count as u64;

    loop {
        interval.tick().await;

        let header = AudioPacketHeader {
            codec: AudioCodec::PcmF32,
            seq,
            first_sample_index: sample_index,
            frame_count,
            sample_rate_hz: SAMPLE_RATE_HZ,
            channel_count: 2,
            server_presentation_time_ns: stream_time_ns(
                state.stream_started_at_ns,
                sample_index,
                SAMPLE_RATE_HZ,
            ),
        };
        let payload = state.source.payload_for(sample_index, frame_count);
        let packet = encode_audio_packet(&header, &payload);

        if socket.send(Message::Binary(packet.into())).await.is_err() {
            break;
        }

        seq += 1;
        sample_index += frame_count as u64;
    }
}

impl AppState {
    fn track_control_connection(self: &Arc<Self>) -> AudienceCounterGuard {
        let client_id = self.next_client_id.fetch_add(1, Ordering::AcqRel);
        self.clients
            .lock()
            .expect("clients mutex poisoned")
            .insert(client_id, ClientDiagnostic::new(client_id, unix_time_ms()));
        self.connected_clients.fetch_add(1, Ordering::AcqRel);
        self.broadcast_audience_stats();
        AudienceCounterGuard {
            state: Arc::clone(self),
            kind: AudienceCounterKind::Control { client_id },
        }
    }

    fn track_audio_socket(self: &Arc<Self>) -> AudienceCounterGuard {
        self.active_audio_sockets.fetch_add(1, Ordering::AcqRel);
        self.broadcast_audience_stats();
        AudienceCounterGuard {
            state: Arc::clone(self),
            kind: AudienceCounterKind::Audio,
        }
    }

    fn track_info_message(&self) -> ControlMessage {
        ControlMessage::TrackInfo {
            title: self.source.title.clone(),
            artist: self.source.artist.clone(),
            filename: self
                .source
                .path
                .file_name()
                .and_then(|file_name| file_name.to_str())
                .unwrap_or("unknown")
                .to_string(),
            duration_ms: self.source.frame_count as f64 * 1_000.0
                / self.source.sample_rate_hz as f64,
            sample_rate_hz: self.source.sample_rate_hz,
            channel_count: self.source.channel_count,
        }
    }

    fn audience_stats_message(&self) -> ControlMessage {
        ControlMessage::AudienceStats {
            connected_clients: saturating_usize_to_u32(
                self.connected_clients.load(Ordering::Acquire),
            ),
            active_listeners: saturating_usize_to_u32(
                self.active_audio_sockets.load(Ordering::Acquire),
            ),
            audio_sockets: saturating_usize_to_u32(
                self.active_audio_sockets.load(Ordering::Acquire),
            ),
        }
    }

    fn broadcast_audience_stats(&self) {
        let _ = self.control_tx.send(self.audience_stats_message());
    }

    fn update_client_identity(&self, client_id: usize, device_id: String, user_agent: String) {
        let mut clients = self.clients.lock().expect("clients mutex poisoned");
        if let Some(client) = clients.get_mut(&client_id) {
            client.device_id = Some(device_id);
            client.user_agent = Some(user_agent);
            client.last_seen_ms = unix_time_ms();
        }
    }

    fn update_client_status(&self, client_id: usize, patch: ClientStatusPatch) {
        let mut clients = self.clients.lock().expect("clients mutex poisoned");
        if let Some(client) = clients.get_mut(&client_id) {
            client.last_seen_ms = unix_time_ms();
            client.rtt_ms = Some(patch.rtt_ms);
            client.clock_offset_ms = Some(patch.clock_offset_ms);
            client.buffer_ms = Some(patch.buffer_ms);
            client.playback_error_ms = Some(patch.playback_error_ms);
            client.playback_error_p95_ms = patch.playback_error_p95_ms;
            client.playback_error_max_ms = patch.playback_error_max_ms;
            client.resample_ratio = Some(patch.resample_ratio);
            client.underruns = patch.underruns;
            client.late_drops = patch.late_drops.unwrap_or(client.late_drops);
            client.resyncs = patch.resyncs.unwrap_or(client.resyncs);
            client.device_output_offset_ms = patch.device_output_offset_ms;
        }
    }

    fn remove_client(&self, client_id: usize) {
        self.clients
            .lock()
            .expect("clients mutex poisoned")
            .remove(&client_id);
    }

    fn client_diagnostics(&self) -> ClientDiagnosticsResponse {
        let mut clients = self
            .clients
            .lock()
            .expect("clients mutex poisoned")
            .values()
            .cloned()
            .collect::<Vec<_>>();
        clients.sort_by_key(|client| client.id);

        ClientDiagnosticsResponse {
            server_time_ms: unix_time_ms(),
            clients,
        }
    }
}

impl Drop for AudienceCounterGuard {
    fn drop(&mut self) {
        match self.kind {
            AudienceCounterKind::Control { client_id } => {
                self.state.connected_clients.fetch_sub(1, Ordering::AcqRel);
                self.state.remove_client(client_id);
            }
            AudienceCounterKind::Audio => {
                self.state
                    .active_audio_sockets
                    .fetch_sub(1, Ordering::AcqRel);
            }
        }

        self.state.broadcast_audience_stats();
    }
}

impl AudienceCounterGuard {
    fn client_id(&self) -> usize {
        match self.kind {
            AudienceCounterKind::Control { client_id } => client_id,
            AudienceCounterKind::Audio => 0,
        }
    }
}

impl ClientDiagnostic {
    fn new(id: usize, now_ms: f64) -> Self {
        Self {
            id,
            device_id: None,
            user_agent: None,
            connected_at_ms: now_ms,
            last_seen_ms: now_ms,
            rtt_ms: None,
            clock_offset_ms: None,
            buffer_ms: None,
            playback_error_ms: None,
            playback_error_p95_ms: None,
            playback_error_max_ms: None,
            resample_ratio: None,
            underruns: 0,
            late_drops: 0,
            resyncs: 0,
            device_output_offset_ms: None,
        }
    }
}

fn saturating_usize_to_u32(value: usize) -> u32 {
    value.try_into().unwrap_or(u32::MAX)
}

fn unix_time_ms() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs_f64()
        * 1_000.0
}

fn unix_time_ns() -> i128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos() as i128
}

fn current_stream_sample_index(stream_started_at_ns: i128) -> u64 {
    let elapsed_ns = (unix_time_ns() - stream_started_at_ns).max(0) as u128;
    ((elapsed_ns * SAMPLE_RATE_HZ as u128) / 1_000_000_000) as u64
}

fn stream_time_ns(stream_started_at_ns: i128, sample_index: u64, sample_rate_hz: u32) -> i128 {
    stream_started_at_ns + (sample_index as i128 * 1_000_000_000_i128) / sample_rate_hz as i128
}

impl AudioSource {
    fn payload_for(&self, first_sample_index: u64, frame_count: u32) -> Vec<u8> {
        let channel_count = self.channel_count as usize;
        let mut payload = Vec::with_capacity(frame_count as usize * channel_count * 4);

        for frame in 0..frame_count as u64 {
            let source_frame = (first_sample_index + frame) % self.frame_count;
            let sample_offset = source_frame as usize * channel_count;

            for channel in 0..channel_count {
                payload.extend_from_slice(&self.samples[sample_offset + channel].to_le_bytes());
            }
        }

        payload
    }
}

fn load_first_track(track_dir: &Path) -> anyhow::Result<AudioSource> {
    let mut candidates = std::fs::read_dir(track_dir)?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.is_file())
        .filter(|path| {
            matches!(
                path.extension().and_then(|extension| extension.to_str()),
                Some("flac" | "wav")
            )
        })
        .collect::<Vec<_>>();

    candidates.sort();

    let path = candidates
        .into_iter()
        .next()
        .ok_or_else(|| anyhow::anyhow!("no .flac or .wav file found in {}", track_dir.display()))?;

    decode_track(&path)
}

fn decode_track(path: &Path) -> anyhow::Result<AudioSource> {
    let metadata = infer_track_metadata(path);
    let file = File::open(path)?;
    let media_source = MediaSourceStream::new(Box::new(file), Default::default());
    let mut hint = Hint::new();

    if let Some(extension) = path.extension().and_then(|extension| extension.to_str()) {
        hint.with_extension(extension);
    }

    let probed = symphonia::default::get_probe().format(
        &hint,
        media_source,
        &FormatOptions::default(),
        &MetadataOptions::default(),
    )?;
    let mut format = probed.format;

    let track = format
        .default_track()
        .ok_or_else(|| anyhow::anyhow!("{} has no default audio track", path.display()))?;
    let track_id = track.id;
    let sample_rate_hz = track
        .codec_params
        .sample_rate
        .ok_or_else(|| anyhow::anyhow!("{} has unknown sample rate", path.display()))?;
    let channel_count = track
        .codec_params
        .channels
        .ok_or_else(|| anyhow::anyhow!("{} has unknown channel layout", path.display()))?
        .count();

    if sample_rate_hz != SAMPLE_RATE_HZ {
        anyhow::bail!(
            "{} is {} Hz, expected {} Hz. Convert it before loading.",
            path.display(),
            sample_rate_hz,
            SAMPLE_RATE_HZ
        );
    }

    if channel_count != 2 {
        anyhow::bail!(
            "{} has {} channels, expected stereo.",
            path.display(),
            channel_count
        );
    }

    let mut decoder =
        symphonia::default::get_codecs().make(&track.codec_params, &DecoderOptions::default())?;
    let mut samples = Vec::new();

    loop {
        let packet = match format.next_packet() {
            Ok(packet) => packet,
            Err(SymphoniaError::IoError(error))
                if error.kind() == std::io::ErrorKind::UnexpectedEof =>
            {
                break;
            }
            Err(SymphoniaError::ResetRequired) => {
                anyhow::bail!(
                    "{} requires decoder reset, unsupported for now",
                    path.display()
                );
            }
            Err(error) => return Err(error.into()),
        };

        if packet.track_id() != track_id {
            continue;
        }

        let decoded = match decoder.decode(&packet) {
            Ok(decoded) => decoded,
            Err(SymphoniaError::DecodeError(error)) => {
                warn!(%error, path = %path.display(), "skipping corrupt audio packet");
                continue;
            }
            Err(error) => return Err(error.into()),
        };

        append_audio_buffer(decoded, &mut samples);
    }

    let frame_count = samples.len() / channel_count;
    if frame_count == 0 {
        anyhow::bail!("{} decoded to an empty audio buffer", path.display());
    }

    Ok(AudioSource {
        path: path.to_path_buf(),
        title: metadata.title,
        artist: metadata.artist,
        samples,
        frame_count: frame_count as u64,
        channel_count: channel_count as u16,
        sample_rate_hz,
    })
}

struct TrackMetadata {
    title: String,
    artist: Option<String>,
}

fn infer_track_metadata(path: &Path) -> TrackMetadata {
    let stem = path
        .file_stem()
        .and_then(|stem| stem.to_str())
        .unwrap_or("Unknown Track")
        .trim();

    let Some((artist, title)) = stem.rsplit_once(" - ") else {
        return TrackMetadata {
            title: clean_track_text(stem),
            artist: None,
        };
    };

    TrackMetadata {
        title: clean_track_text(title),
        artist: Some(
            artist
                .split(',')
                .map(clean_track_text)
                .filter(|part| !part.is_empty())
                .collect::<Vec<_>>()
                .join(", "),
        )
        .filter(|artist| !artist.is_empty()),
    }
}

fn clean_track_text(value: &str) -> String {
    value
        .trim()
        .trim_matches(|ch| {
            matches!(
                ch,
                '"' | '\'' | '`' | '\u{201c}' | '\u{201d}' | '\u{300c}' | '\u{300d}'
            )
        })
        .trim()
        .to_string()
}

fn append_audio_buffer(buffer: AudioBufferRef<'_>, output: &mut Vec<f32>) {
    let mut sample_buffer = SampleBuffer::<f32>::new(buffer.frames() as u64, *buffer.spec());
    sample_buffer.copy_interleaved_ref(buffer);
    output.extend_from_slice(sample_buffer.samples());
}

async fn shutdown_signal() {
    let ctrl_c = async {
        tokio::signal::ctrl_c()
            .await
            .expect("failed to install Ctrl+C handler");
    };

    #[cfg(unix)]
    let terminate = async {
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("failed to install signal handler")
            .recv()
            .await;
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }
}
