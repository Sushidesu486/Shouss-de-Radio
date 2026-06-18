import { useEffect, useMemo, useRef, useState } from "react";
import type { WorkerCommand, WorkerEvent } from "../protocol/types";

type ConnectionState = "idle" | "connecting" | "connected" | "closed" | "error";

type ClockState = {
  rttMs: number | null;
  clockOffsetMs: number | null;
  sampleCount: number;
};

type SessionState = {
  targetLatencyMs: number | null;
  sampleRateHz: number | null;
  sceneVersion: number | null;
};

type TrackState = {
  title: string;
  artist: string | null;
  filename: string;
  durationMs: number;
  sampleRateHz: number;
  channelCount: number;
};

type AudienceState = {
  connectedClients: number;
  activeListeners: number;
  audioSockets: number;
};

type AudioStatsState = {
  packets: number;
  kilobitsPerSecond: number | null;
  lastSeq: number | null;
  lastFirstSampleIndex: number | null;
  lastPayloadBytes: number | null;
  playoutLeadMs: number | null;
  packetGapMs: number | null;
  jitterMs: number | null;
};

type SyncStatsState = {
  syncErrorMs: number | null;
  bufferLeadMs: number | null;
  playbackRatio: number | null;
  anchorErrorMs: number | null;
  underruns: number;
  lateDrops: number;
  resyncs: number;
  queuedPackets: number;
};

type NetworkSample = {
  at: number;
  rttMs: number | null;
  jitterMs: number | null;
  leadDriftMs: number | null;
  kilobitsPerSecond: number | null;
};

type ThemeMode = "light" | "dark";

const MAX_NETWORK_SAMPLES = 240;

const createDeviceId = () => {
  const existing = localStorage.getItem("radio.deviceId");
  if (existing) {
    return existing;
  }

  const value = crypto.randomUUID();
  localStorage.setItem("radio.deviceId", value);
  return value;
};

const createThemeMode = (): ThemeMode => {
  const stored = localStorage.getItem("radio.theme");
  if (stored === "dark" || stored === "light") {
    return stored;
  }

  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
};

const createDeviceOutputOffsetMs = () => {
  const stored = Number(localStorage.getItem("radio.deviceOutputOffsetMs"));
  return Number.isFinite(stored) ? stored : 0;
};

const nowMs = () => performance.timeOrigin + performance.now();

const formatMs = (value: number | null, digits = 1) => {
  if (value === null || Number.isNaN(value)) {
    return "-";
  }

  return `${value.toFixed(digits)} ms`;
};

const formatNumber = (value: number | null) => {
  if (value === null || Number.isNaN(value)) {
    return "-";
  }

  return value.toLocaleString("en-US", { maximumFractionDigits: 0 });
};

const formatDuration = (valueMs: number | null) => {
  if (valueMs === null || Number.isNaN(valueMs)) {
    return "-";
  }

  const totalSeconds = Math.max(0, Math.round(valueMs / 1_000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
};

const formatRatio = (value: number | null) => {
  if (value === null || Number.isNaN(value)) {
    return "-";
  }

  return value.toFixed(6);
};

const connectionLabel = (state: ConnectionState) => {
  switch (state) {
    case "connected":
      return "已连接";
    case "connecting":
      return "连接中";
    case "closed":
      return "已断开";
    case "error":
      return "错误";
    case "idle":
    default:
      return "未连接";
  }
};

const pushSample = (
  samples: NetworkSample[],
  patch: Omit<NetworkSample, "at"> & { at?: number }
) => {
  const previous = samples.at(-1);
  const next: NetworkSample = {
    at: patch.at ?? performance.now(),
    rttMs: patch.rttMs ?? previous?.rttMs ?? null,
    jitterMs: patch.jitterMs ?? previous?.jitterMs ?? null,
    leadDriftMs: patch.leadDriftMs ?? previous?.leadDriftMs ?? null,
    kilobitsPerSecond:
      patch.kilobitsPerSecond ?? previous?.kilobitsPerSecond ?? null
  };

  return [...samples, next].slice(-MAX_NETWORK_SAMPLES);
};

export function App() {
  const workerRef = useRef<Worker | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const workletNodeRef = useRef<AudioWorkletNode | null>(null);
  const streamEnabledRef = useRef(false);
  const targetLatencyRef = useRef<number | null>(null);
  const clockRef = useRef<ClockState>({
    rttMs: null,
    clockOffsetMs: null,
    sampleCount: 0
  });
  const [connectionState, setConnectionState] = useState<ConnectionState>("idle");
  const [clock, setClock] = useState<ClockState>({
    rttMs: null,
    clockOffsetMs: null,
    sampleCount: 0
  });
  const [session, setSession] = useState<SessionState>({
    targetLatencyMs: null,
    sampleRateHz: null,
    sceneVersion: null
  });
  const [track, setTrack] = useState<TrackState | null>(null);
  const [audience, setAudience] = useState<AudienceState>({
    connectedClients: 0,
    activeListeners: 0,
    audioSockets: 0
  });
  const [audioReady, setAudioReady] = useState(false);
  const [streamEnabled, setStreamEnabled] = useState(false);
  const [audioStats, setAudioStats] = useState<AudioStatsState>({
    packets: 0,
    kilobitsPerSecond: null,
    lastSeq: null,
    lastFirstSampleIndex: null,
    lastPayloadBytes: null,
    playoutLeadMs: null,
    packetGapMs: null,
    jitterMs: null
  });
  const [networkSamples, setNetworkSamples] = useState<NetworkSample[]>([]);
  const [themeMode, setThemeMode] = useState<ThemeMode>(createThemeMode);
  const [deviceOutputOffsetMs, setDeviceOutputOffsetMs] = useState(
    createDeviceOutputOffsetMs
  );
  const [calibrationPulseEnabled, setCalibrationPulseEnabled] = useState(false);
  const [syncStats, setSyncStats] = useState<SyncStatsState>({
    syncErrorMs: null,
    bufferLeadMs: null,
    playbackRatio: null,
    anchorErrorMs: null,
    underruns: 0,
    lateDrops: 0,
    resyncs: 0,
    queuedPackets: 0
  });

  const deviceId = useMemo(createDeviceId, []);

  useEffect(() => {
    document.documentElement.dataset.theme = themeMode;
    localStorage.setItem("radio.theme", themeMode);
  }, [themeMode]);

  useEffect(() => {
    clockRef.current = clock;
  }, [clock]);

  useEffect(() => {
    localStorage.setItem("radio.deviceOutputOffsetMs", `${deviceOutputOffsetMs}`);
    workerRef.current?.postMessage({
      type: "setDeviceOffset",
      offsetMs: deviceOutputOffsetMs
    } satisfies WorkerCommand);
  }, [deviceOutputOffsetMs]);

  useEffect(() => {
    const worker = new Worker(new URL("../workers/radio-worker.ts", import.meta.url), {
      type: "module"
    });
    workerRef.current = worker;
    worker.postMessage({
      type: "setDeviceOffset",
      offsetMs: deviceOutputOffsetMs
    } satisfies WorkerCommand);

    worker.onmessage = (event: MessageEvent<WorkerEvent>) => {
      const message = event.data;

      if (message.type === "audioPacket") {
        const audioContext = audioContextRef.current;
        if (
          streamEnabledRef.current &&
          workletNodeRef.current &&
          audioContext &&
          message.targetPlaybackTimeMs !== null
        ) {
          const targetContextFrame = Math.round(
            (audioContext.currentTime +
              (message.targetPlaybackTimeMs - nowMs()) / 1_000) *
              audioContext.sampleRate
          );
          workletNodeRef.current.port.postMessage(
            {
              type: "timelinePacket",
              payload: message.payload,
              frameCount: message.frameCount,
              channelCount: message.channelCount,
              firstSampleIndex: message.firstSampleIndex,
              targetContextFrame
            },
            [message.payload]
          );
        }
        return;
      }

      if (message.type === "connection") {
        setConnectionState(message.state);
        if (message.state === "idle" || message.state === "closed") {
          setStreamEnabled(false);
        }
      }

      if (message.type === "clock") {
        const rttMs = message.rttMs;

        setClock({
          rttMs,
          clockOffsetMs: message.clockOffsetMs,
          sampleCount: message.sampleCount
        });
        setNetworkSamples((samples) =>
          pushSample(samples, {
            rttMs,
            jitterMs: null,
            leadDriftMs: null,
            kilobitsPerSecond: null
          })
        );
      }

      if (message.type === "session") {
        targetLatencyRef.current = message.targetLatencyMs;
        setSession({
          targetLatencyMs: message.targetLatencyMs,
          sampleRateHz: message.sampleRateHz,
          sceneVersion: message.sceneVersion
        });
      }

      if (message.type === "track") {
        setTrack({
          title: message.title,
          artist: message.artist,
          filename: message.filename,
          durationMs: message.durationMs,
          sampleRateHz: message.sampleRateHz,
          channelCount: message.channelCount
        });
      }

      if (message.type === "audience") {
        setAudience({
          connectedClients: message.connectedClients,
          activeListeners: message.activeListeners,
          audioSockets: message.audioSockets
        });
      }

      if (message.type === "audio") {
        const jitterMs = message.jitterMs;
        const kilobitsPerSecond = message.kilobitsPerSecond;
        const leadDriftMs =
          message.playoutLeadMs === null || targetLatencyRef.current === null
            ? null
            : message.playoutLeadMs - targetLatencyRef.current;

        setAudioStats({
          packets: message.packets,
          kilobitsPerSecond,
          lastSeq: message.lastSeq,
          lastFirstSampleIndex: message.lastFirstSampleIndex,
          lastPayloadBytes: message.lastPayloadBytes,
          playoutLeadMs: message.playoutLeadMs,
          packetGapMs: message.packetGapMs,
          jitterMs
        });
        setNetworkSamples((samples) =>
          pushSample(samples, {
            rttMs: null,
            jitterMs,
            leadDriftMs,
            kilobitsPerSecond
          })
        );
      }
    };

    return () => {
      worker.terminate();
      workerRef.current = null;
    };
  }, []);

  useEffect(() => {
    streamEnabledRef.current = streamEnabled;
    workletNodeRef.current?.port.postMessage({
      type: "enabled",
      enabled: streamEnabled
    });
  }, [streamEnabled]);

  useEffect(() => {
    workletNodeRef.current?.port.postMessage({
      type: "calibrationPulse",
      enabled: calibrationPulseEnabled
    });
  }, [calibrationPulseEnabled]);

  const postWorker = (command: WorkerCommand) => {
    workerRef.current?.postMessage(command);
  };

  const connect = () => {
    postWorker({ type: "connect", deviceId });
  };

  const disconnect = () => {
    setStreamEnabled(false);
    postWorker({ type: "disconnect" });
  };

  const ensureAudio = async () => {
    if (audioContextRef.current && workletNodeRef.current) {
      if (audioContextRef.current.state !== "running") {
        await audioContextRef.current.resume();
      }
      return;
    }

    const audioContext = new AudioContext({ sampleRate: 48_000 });
    await audioContext.audioWorklet.addModule(
      new URL("../audio/radio-worklet.js", import.meta.url)
    );

    const node = new AudioWorkletNode(audioContext, "radio-player", {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2]
    });
    node.port.onmessage = (event) => {
      if (event.data.type === "syncStats") {
        const syncErrorMs = event.data.syncErrorMs;
        setSyncStats({
          syncErrorMs,
          bufferLeadMs: event.data.bufferLeadMs,
          playbackRatio: event.data.playbackRatio,
          anchorErrorMs: event.data.anchorErrorMs,
          underruns: event.data.underruns,
          lateDrops: event.data.lateDrops,
          resyncs: event.data.resyncs,
          queuedPackets: event.data.queuedPackets
        });
        setNetworkSamples((samples) =>
          pushSample(samples, {
            rttMs: null,
            jitterMs: null,
            leadDriftMs: syncErrorMs,
            kilobitsPerSecond: null
          })
        );
        workerRef.current?.postMessage({
          type: "reportClientStatus",
          rttMs: clockRef.current.rttMs ?? 0,
          clockOffsetMs: clockRef.current.clockOffsetMs ?? 0,
          bufferMs: event.data.bufferLeadMs ?? 0,
          playbackErrorMs: syncErrorMs ?? 0,
          resampleRatio: event.data.playbackRatio ?? 1,
          underruns: event.data.underruns
        } satisfies WorkerCommand);
      }
    };
    node.connect(audioContext.destination);

    audioContextRef.current = audioContext;
    workletNodeRef.current = node;
    node.port.postMessage({
      type: "calibrationPulse",
      enabled: calibrationPulseEnabled
    });
    setAudioReady(true);
  };

  const startListening = async () => {
    await ensureAudio();

    if (connectionState !== "connected" && connectionState !== "connecting") {
      connect();
    }

    setStreamEnabled(true);
    postWorker({ type: "setDeviceOffset", offsetMs: deviceOutputOffsetMs });
    postWorker({ type: "setAudioEnabled", enabled: true });
  };

  const pauseListening = () => {
    setStreamEnabled(false);
    postWorker({ type: "setAudioEnabled", enabled: false });
  };

  const leadDriftMs =
    audioStats.playoutLeadMs === null || session.targetLatencyMs === null
      ? null
      : audioStats.playoutLeadMs - session.targetLatencyMs;
  const trackTitle = track?.title ?? "等待曲目";
  const trackArtist = track?.artist ?? "Shouss de Radio";
  const streamStatus = streamEnabled ? "正在收听" : "待机";

  return (
    <main className="shell">
      <section className="topbar">
        <div>
          <p className="eyebrow">公网同步电台</p>
          <h1>Shouss de Radio</h1>
        </div>
        <div className="topbar-actions">
          <label className="theme-toggle">
            <span>深色</span>
            <input
              type="checkbox"
              checked={themeMode === "dark"}
              onChange={(event) =>
                setThemeMode(event.currentTarget.checked ? "dark" : "light")
              }
            />
          </label>
          <button onClick={connect} disabled={connectionState === "connected"}>
            连接
          </button>
          <button onClick={disconnect} disabled={connectionState === "idle"}>
            断开
          </button>
        </div>
      </section>

      <section className="player-panel">
        <div className="track-block">
          <p className="eyebrow">{streamStatus}</p>
          <h2>{trackTitle}</h2>
          <p className="artist">{trackArtist}</p>
          <div className="track-meta" aria-label="Track metadata">
            <span>{formatDuration(track?.durationMs ?? null)}</span>
            <span>{track?.sampleRateHz ?? session.sampleRateHz ?? "-"} Hz</span>
            <span>{track?.channelCount ?? "-"} ch</span>
            <span>{track?.filename ?? "-"}</span>
          </div>
        </div>

        <div className="listen-block">
          <div className="listener-count">
            <span>{audience.activeListeners}</span>
            <p>正在收听</p>
          </div>
          <button
            className="primary-action"
            onClick={streamEnabled ? pauseListening : startListening}
            disabled={connectionState === "connecting"}
          >
            {streamEnabled ? "暂停" : "收听"}
          </button>
        </div>
      </section>

      <section className="overview-grid">
        <MetricCard
          label="连接"
          value={connectionLabel(connectionState)}
          detail={`设备 ${deviceId.slice(0, 8)}`}
        />
        <MetricCard
          label="在线"
          value={audience.connectedClients.toString()}
          detail={`${audience.audioSockets} 条音频流`}
        />
        <MetricCard
          label="RTT"
          value={formatMs(clock.rttMs)}
          detail={`offset ${formatMs(clock.clockOffsetMs)}`}
        />
        <MetricCard
          label="码率"
          value={
            audioStats.kilobitsPerSecond === null
              ? "-"
              : `${audioStats.kilobitsPerSecond.toFixed(1)} kbps`
          }
          detail={`jitter ${formatMs(audioStats.jitterMs)}`}
        />
        <MetricCard
          label="同步误差"
          value={formatMs(syncStats.syncErrorMs)}
          detail={`buffer ${formatMs(syncStats.bufferLeadMs)}`}
        />
        <MetricCard
          label="漂移修正"
          value={formatRatio(syncStats.playbackRatio)}
          detail={`${syncStats.queuedPackets} packets queued`}
        />
      </section>

      <section className="network-panel">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Network</p>
            <h2>网络波动</h2>
          </div>
          <div className="legend">
            <span className="legend-rtt">RTT</span>
            <span className="legend-jitter">Jitter</span>
            <span className="legend-lead">Sync Error</span>
          </div>
        </div>
        <NetworkChart samples={networkSamples} themeMode={themeMode} />
      </section>

      <section className="debug-grid">
        <article className="panel">
          <h2>Session</h2>
          <dl>
            <div>
              <dt>Latency</dt>
              <dd>
                {session.targetLatencyMs === null ? "-" : `${session.targetLatencyMs} ms`}
              </dd>
            </div>
            <div>
              <dt>Sample Rate</dt>
              <dd>{session.sampleRateHz === null ? "-" : `${session.sampleRateHz} Hz`}</dd>
            </div>
            <div>
              <dt>Scene</dt>
              <dd>{session.sceneVersion ?? "-"}</dd>
            </div>
            <div>
              <dt>Clock Samples</dt>
              <dd>{clock.sampleCount}</dd>
            </div>
          </dl>
        </article>

        <article className="panel">
          <h2>Audio Stream</h2>
          <dl>
            <div>
              <dt>Audio</dt>
              <dd>{audioReady ? "ready" : "locked"}</dd>
            </div>
            <div>
              <dt>Packets</dt>
              <dd>{audioStats.packets}</dd>
            </div>
            <div>
              <dt>Seq</dt>
              <dd>{formatNumber(audioStats.lastSeq)}</dd>
            </div>
            <div>
              <dt>Sample</dt>
              <dd>{formatNumber(audioStats.lastFirstSampleIndex)}</dd>
            </div>
            <div>
              <dt>Payload</dt>
              <dd>
                {audioStats.lastPayloadBytes === null
                  ? "-"
                  : `${audioStats.lastPayloadBytes} B`}
              </dd>
            </div>
            <div>
              <dt>Lead Drift</dt>
              <dd>{formatMs(leadDriftMs)}</dd>
            </div>
          </dl>
        </article>

        <article className="panel calibration-panel">
          <h2>Device Calibration</h2>
          <p className="panel-note">正数延后本设备，负数提前本设备。</p>
          <label className="pulse-toggle">
            <input
              type="checkbox"
              checked={calibrationPulseEnabled}
              onChange={(event) =>
                setCalibrationPulseEnabled(event.currentTarget.checked)
              }
            />
            <span>校准脉冲</span>
          </label>
          <label className="offset-control">
            <span>Offset</span>
            <input
              type="range"
              min="-200"
              max="200"
              step="1"
              value={deviceOutputOffsetMs}
              onChange={(event) =>
                setDeviceOutputOffsetMs(
                  clamp(Number(event.currentTarget.value), -200, 200)
                )
              }
            />
          </label>
          <div className="offset-row">
            <input
              type="number"
              min="-200"
              max="200"
              step="1"
              value={deviceOutputOffsetMs}
              onChange={(event) =>
                setDeviceOutputOffsetMs(
                  clamp(Number(event.currentTarget.value), -200, 200)
                )
              }
            />
            <span>ms</span>
          </div>
          <dl>
            <div>
              <dt>Anchor Error</dt>
              <dd>{formatMs(syncStats.anchorErrorMs)}</dd>
            </div>
            <div>
              <dt>Underruns</dt>
              <dd>{syncStats.underruns}</dd>
            </div>
            <div>
              <dt>Late Drops</dt>
              <dd>{syncStats.lateDrops}</dd>
            </div>
            <div>
              <dt>Resyncs</dt>
              <dd>{syncStats.resyncs}</dd>
            </div>
          </dl>
        </article>
      </section>
    </main>
  );
}

function MetricCard({
  label,
  value,
  detail
}: {
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <article className="metric-card">
      <p>{label}</p>
      <strong>{value}</strong>
      <span>{detail}</span>
    </article>
  );
}

function NetworkChart({
  samples,
  themeMode
}: {
  samples: NetworkSample[];
  themeMode: ThemeMode;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }

    const context = canvas.getContext("2d");
    if (!context) {
      return;
    }

    const ratio = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    const width = Math.max(320, rect.width);
    const height = Math.max(240, rect.height);
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, width, height);

    const styles = getComputedStyle(document.documentElement);
    const color = (name: string) => styles.getPropertyValue(name).trim();
    const chartBackground = color("--chart-background");
    const chartGrid = color("--chart-grid");
    const chartText = color("--chart-text");
    const chartLeadZero = color("--chart-lead-zero");
    const chartRtt = color("--chart-rtt");
    const chartJitter = color("--chart-jitter");
    const chartLead = color("--chart-lead");

    context.fillStyle = chartBackground;
    context.fillRect(0, 0, width, height);

    const paddingLeft = 58;
    const paddingRight = 16;
    const paddingTop = 16;
    const paddingBottom = 18;
    const plotWidth = width - paddingLeft - paddingRight;
    const plotHeight = height - paddingTop - paddingBottom;
    const laneHeight = plotHeight / 3;

    const lanes = [
      {
        label: "RTT",
        unit: "ms",
        color: chartRtt,
        values: samples.map((sample) => sample.rttMs),
        map: (value: number, max: number) => 1 - value / max,
        scale: maxOf(samples.map((sample) => sample.rttMs), 80)
      },
      {
        label: "Jitter",
        unit: "ms",
        color: chartJitter,
        values: samples.map((sample) => sample.jitterMs),
        map: (value: number, max: number) => 1 - value / max,
        scale: maxOf(samples.map((sample) => sample.jitterMs), 40)
      },
      {
        label: "Sync",
        unit: "ms",
        color: chartLead,
        values: samples.map((sample) => sample.leadDriftMs),
        map: (value: number, max: number) => 0.5 - value / (max * 2),
        scale: maxAbsOf(samples.map((sample) => sample.leadDriftMs), 120)
      }
    ];

    context.strokeStyle = chartGrid;
    context.lineWidth = 1;
    for (let index = 0; index <= 3; index += 1) {
      const y = paddingTop + index * laneHeight;
      context.beginPath();
      context.moveTo(paddingLeft, y);
      context.lineTo(width - paddingRight, y);
      context.stroke();
    }

    context.font =
      '12px Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    context.textBaseline = "middle";

    lanes.forEach((lane, laneIndex) => {
      const laneTop = paddingTop + laneIndex * laneHeight;
      const laneCenter = laneTop + laneHeight / 2;
      const latest = latestValue(lane.values);

      context.fillStyle = chartText;
      context.fillText(lane.label, 12, laneCenter - 8);
      context.fillText(
        latest === null ? "-" : `${latest.toFixed(1)} ${lane.unit}`,
        12,
        laneCenter + 10
      );

      if (lane.label === "Sync") {
        context.strokeStyle = chartLeadZero;
        context.beginPath();
        context.moveTo(paddingLeft, laneCenter);
        context.lineTo(width - paddingRight, laneCenter);
        context.stroke();
      }

      context.strokeStyle = lane.color;
      context.lineWidth = 2;
      context.beginPath();

      let started = false;
      lane.values.forEach((value, sampleIndex) => {
        if (value === null) {
          return;
        }

        const x =
          paddingLeft +
          (samples.length <= 1
            ? plotWidth
            : (sampleIndex / (samples.length - 1)) * plotWidth);
        const normalized = clamp(lane.map(value, lane.scale), 0.08, 0.92);
        const y = laneTop + normalized * laneHeight;

        if (!started) {
          context.moveTo(x, y);
          started = true;
        } else {
          context.lineTo(x, y);
        }
      });

      context.stroke();
    });
  }, [samples, themeMode]);

  return <canvas ref={canvasRef} className="network-canvas" aria-label="Network fluctuation" />;
}

function latestValue(values: Array<number | null>) {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    const value = values[index];
    if (value !== null && Number.isFinite(value)) {
      return value;
    }
  }

  return null;
}

function maxOf(values: Array<number | null>, floor: number) {
  const max = values.reduce<number>((result, value) => {
    if (value === null || !Number.isFinite(value)) {
      return result;
    }

    return Math.max(result, value);
  }, floor);

  return Math.max(floor, max * 1.2);
}

function maxAbsOf(values: Array<number | null>, floor: number) {
  const max = values.reduce<number>((result, value) => {
    if (value === null || !Number.isFinite(value)) {
      return result;
    }

    return Math.max(result, Math.abs(value));
  }, floor);

  return Math.max(floor, max * 1.2);
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}
