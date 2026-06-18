use serde::{Deserialize, Serialize};

pub const SAMPLE_RATE_HZ: u32 = 48_000;
pub const DEFAULT_PACKET_FRAMES: u32 = 960;
pub const DEFAULT_TARGET_LATENCY_MS: u32 = 8_000;
pub const AUDIO_PACKET_MAGIC: [u8; 4] = *b"SRAD";
pub const AUDIO_PACKET_VERSION: u8 = 1;
pub const AUDIO_PACKET_HEADER_LEN: usize = 54;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AudioCodec {
    PcmF32,
    Opus,
}

impl AudioCodec {
    pub fn wire_id(self) -> u8 {
        match self {
            AudioCodec::PcmF32 => 1,
            AudioCodec::Opus => 2,
        }
    }

    pub fn from_wire_id(value: u8) -> Result<Self, AudioPacketError> {
        match value {
            1 => Ok(AudioCodec::PcmF32),
            2 => Ok(AudioCodec::Opus),
            _ => Err(AudioPacketError::UnsupportedCodec(value)),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioPacketHeader {
    pub codec: AudioCodec,
    pub seq: u64,
    pub first_sample_index: u64,
    pub frame_count: u32,
    pub sample_rate_hz: u32,
    pub channel_count: u16,
    pub server_presentation_time_ns: i128,
}

impl AudioPacketHeader {
    pub fn duration_ms(&self) -> f64 {
        self.frame_count as f64 * 1_000.0 / self.sample_rate_hz as f64
    }

    pub fn encode(&self, payload_len: u32) -> [u8; AUDIO_PACKET_HEADER_LEN] {
        let mut buffer = [0_u8; AUDIO_PACKET_HEADER_LEN];
        buffer[0..4].copy_from_slice(&AUDIO_PACKET_MAGIC);
        buffer[4] = AUDIO_PACKET_VERSION;
        buffer[5] = self.codec.wire_id();
        buffer[6..8].copy_from_slice(&0_u16.to_be_bytes());
        buffer[8..16].copy_from_slice(&self.seq.to_be_bytes());
        buffer[16..24].copy_from_slice(&self.first_sample_index.to_be_bytes());
        buffer[24..28].copy_from_slice(&self.frame_count.to_be_bytes());
        buffer[28..32].copy_from_slice(&self.sample_rate_hz.to_be_bytes());
        buffer[32..34].copy_from_slice(&self.channel_count.to_be_bytes());
        buffer[34..50].copy_from_slice(&self.server_presentation_time_ns.to_be_bytes());
        buffer[50..54].copy_from_slice(&payload_len.to_be_bytes());
        buffer
    }

    pub fn decode(buffer: &[u8]) -> Result<(Self, u32), AudioPacketError> {
        if buffer.len() < AUDIO_PACKET_HEADER_LEN {
            return Err(AudioPacketError::HeaderTooShort {
                actual: buffer.len(),
                expected: AUDIO_PACKET_HEADER_LEN,
            });
        }

        if &buffer[0..4] != AUDIO_PACKET_MAGIC.as_slice() {
            return Err(AudioPacketError::BadMagic);
        }

        if buffer[4] != AUDIO_PACKET_VERSION {
            return Err(AudioPacketError::UnsupportedVersion(buffer[4]));
        }

        let codec = AudioCodec::from_wire_id(buffer[5])?;
        let seq = u64::from_be_bytes(buffer[8..16].try_into().expect("slice length checked"));
        let first_sample_index =
            u64::from_be_bytes(buffer[16..24].try_into().expect("slice length checked"));
        let frame_count =
            u32::from_be_bytes(buffer[24..28].try_into().expect("slice length checked"));
        let sample_rate_hz =
            u32::from_be_bytes(buffer[28..32].try_into().expect("slice length checked"));
        let channel_count =
            u16::from_be_bytes(buffer[32..34].try_into().expect("slice length checked"));
        let server_presentation_time_ns =
            i128::from_be_bytes(buffer[34..50].try_into().expect("slice length checked"));
        let payload_len =
            u32::from_be_bytes(buffer[50..54].try_into().expect("slice length checked"));

        Ok((
            Self {
                codec,
                seq,
                first_sample_index,
                frame_count,
                sample_rate_hz,
                channel_count,
                server_presentation_time_ns,
            },
            payload_len,
        ))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AudioPacketError {
    HeaderTooShort { actual: usize, expected: usize },
    BadMagic,
    UnsupportedVersion(u8),
    UnsupportedCodec(u8),
}

pub fn encode_audio_packet(header: &AudioPacketHeader, payload: &[u8]) -> Vec<u8> {
    let payload_len = payload.len().try_into().expect("payload too large");
    let mut packet = Vec::with_capacity(AUDIO_PACKET_HEADER_LEN + payload.len());
    packet.extend_from_slice(&header.encode(payload_len));
    packet.extend_from_slice(payload);
    packet
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "type"
)]
pub enum ControlMessage {
    Hello {
        device_id: String,
        user_agent: String,
    },
    ClockPing {
        client_send_time_ms: f64,
    },
    ClockPong {
        client_send_time_ms: f64,
        server_receive_time_ms: f64,
        server_send_time_ms: f64,
    },
    SessionConfig {
        target_latency_ms: u32,
        sample_rate_hz: u32,
        scene_version: u64,
    },
    TrackInfo {
        title: String,
        artist: Option<String>,
        filename: String,
        duration_ms: f64,
        sample_rate_hz: u32,
        channel_count: u16,
    },
    AudienceStats {
        connected_clients: u32,
        active_listeners: u32,
        audio_sockets: u32,
    },
    ClientStatus {
        rtt_ms: f64,
        clock_offset_ms: f64,
        buffer_ms: f64,
        playback_error_ms: f64,
        resample_ratio: f64,
        underruns: u64,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClockSyncObservation {
    pub client_send_time_ms: f64,
    pub server_receive_time_ms: f64,
    pub server_send_time_ms: f64,
    pub client_receive_time_ms: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClockSyncEstimate {
    pub rtt_ms: f64,
    pub clock_offset_ms: f64,
}

impl ClockSyncObservation {
    pub fn estimate(self) -> ClockSyncEstimate {
        let rtt_ms = (self.client_receive_time_ms - self.client_send_time_ms)
            - (self.server_send_time_ms - self.server_receive_time_ms);
        let clock_offset_ms = ((self.server_receive_time_ms - self.client_send_time_ms)
            + (self.server_send_time_ms - self.client_receive_time_ms))
            / 2.0;

        ClockSyncEstimate {
            rtt_ms,
            clock_offset_ms,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaybackTarget {
    pub server_time_ms: f64,
    pub target_latency_ms: f64,
    pub sample_rate_hz: u32,
}

impl PlaybackTarget {
    pub fn expected_sample_index(&self) -> u64 {
        let source_time_ms = (self.server_time_ms - self.target_latency_ms).max(0.0);
        ((source_time_ms / 1_000.0) * self.sample_rate_hz as f64).floor() as u64
    }
}
