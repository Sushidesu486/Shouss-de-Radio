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

type AudioStatsState = {
  packets: number;
  kilobitsPerSecond: number | null;
  lastSeq: number | null;
  lastFirstSampleIndex: number | null;
  lastPayloadBytes: number | null;
  playoutLeadMs: number | null;
};

const createDeviceId = () => {
  const existing = localStorage.getItem("radio.deviceId");
  if (existing) {
    return existing;
  }

  const value = crypto.randomUUID();
  localStorage.setItem("radio.deviceId", value);
  return value;
};

export function App() {
  const workerRef = useRef<Worker | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const workletNodeRef = useRef<AudioWorkletNode | null>(null);
  const streamEnabledRef = useRef(false);
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
  const [audioReady, setAudioReady] = useState(false);
  const [streamEnabled, setStreamEnabled] = useState(false);
  const [audioStats, setAudioStats] = useState<AudioStatsState>({
    packets: 0,
    kilobitsPerSecond: null,
    lastSeq: null,
    lastFirstSampleIndex: null,
    lastPayloadBytes: null,
    playoutLeadMs: null
  });

  const deviceId = useMemo(createDeviceId, []);

  useEffect(() => {
    const worker = new Worker(new URL("../workers/radio-worker.ts", import.meta.url), {
      type: "module"
    });
    workerRef.current = worker;

    worker.onmessage = (event: MessageEvent<WorkerEvent>) => {
      if (event.data.type === "audioPacket") {
        if (streamEnabledRef.current && workletNodeRef.current) {
          workletNodeRef.current.port.postMessage(
            {
              type: "pcmPacket",
              payload: event.data.payload,
              frameCount: event.data.frameCount,
              channelCount: event.data.channelCount,
              firstSampleIndex: event.data.firstSampleIndex,
              serverPresentationTimeNs: event.data.serverPresentationTimeNs
            },
            [event.data.payload]
          );
        }
        return;
      }

      if (event.data.type === "connection") {
        setConnectionState(event.data.state);
      }

      if (event.data.type === "clock") {
        setClock({
          rttMs: event.data.rttMs,
          clockOffsetMs: event.data.clockOffsetMs,
          sampleCount: event.data.sampleCount
        });
      }

      if (event.data.type === "session") {
        setSession({
          targetLatencyMs: event.data.targetLatencyMs,
          sampleRateHz: event.data.sampleRateHz,
          sceneVersion: event.data.sceneVersion
        });
      }

      if (event.data.type === "audio") {
        setAudioStats({
          packets: event.data.packets,
          kilobitsPerSecond: event.data.kilobitsPerSecond,
          lastSeq: event.data.lastSeq,
          lastFirstSampleIndex: event.data.lastFirstSampleIndex,
          lastPayloadBytes: event.data.lastPayloadBytes,
          playoutLeadMs: event.data.playoutLeadMs
        });
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

  const postWorker = (command: WorkerCommand) => {
    workerRef.current?.postMessage(command);
  };

  const connect = () => {
    postWorker({ type: "connect", deviceId });
  };

  const disconnect = () => {
    postWorker({ type: "disconnect" });
  };

  const startAudio = async () => {
    const audioContext = new AudioContext({ sampleRate: 48_000 });
    await audioContext.audioWorklet.addModule(
      new URL("../audio/radio-worklet.js", import.meta.url)
    );

    const node = new AudioWorkletNode(audioContext, "radio-player", {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2]
    });
    node.connect(audioContext.destination);

    audioContextRef.current = audioContext;
    workletNodeRef.current = node;
    setAudioReady(true);
  };

  const formatMs = (value: number | null) => {
    if (value === null || Number.isNaN(value)) {
      return "-";
    }

    return `${value.toFixed(2)} ms`;
  };

  const formatNumber = (value: number | null) => {
    if (value === null || Number.isNaN(value)) {
      return "-";
    }

    return value.toLocaleString("en-US", { maximumFractionDigits: 0 });
  };

  return (
    <main className="shell">
      <section className="toolbar">
        <div>
          <h1>Shouss de Radio</h1>
          <p>公网同步电台实验台</p>
        </div>
        <div className="actions">
          <button onClick={connect} disabled={connectionState === "connected"}>
            Connect
          </button>
          <button onClick={disconnect} disabled={connectionState !== "connected"}>
            Disconnect
          </button>
          <button onClick={startAudio} disabled={audioReady}>
            Start Audio
          </button>
        </div>
      </section>

      <section className="status-grid">
        <article className="panel">
          <h2>Connection</h2>
          <dl>
            <div>
              <dt>State</dt>
              <dd>{connectionState}</dd>
            </div>
            <div>
              <dt>Device</dt>
              <dd>{deviceId.slice(0, 8)}</dd>
            </div>
          </dl>
        </article>

        <article className="panel">
          <h2>Clock</h2>
          <dl>
            <div>
              <dt>RTT</dt>
              <dd>{formatMs(clock.rttMs)}</dd>
            </div>
            <div>
              <dt>Offset</dt>
              <dd>{formatMs(clock.clockOffsetMs)}</dd>
            </div>
            <div>
              <dt>Samples</dt>
              <dd>{clock.sampleCount}</dd>
            </div>
          </dl>
        </article>

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
          </dl>
        </article>

        <article className="panel control-panel">
          <h2>Audio</h2>
          <label className="switch">
            <input
              type="checkbox"
              checked={streamEnabled}
              disabled={!audioReady}
              onChange={(event) => setStreamEnabled(event.target.checked)}
            />
            <span>Play Stream</span>
          </label>
        </article>

        <article className="panel">
          <h2>Audio Stream</h2>
          <dl>
            <div>
              <dt>Packets</dt>
              <dd>{audioStats.packets}</dd>
            </div>
            <div>
              <dt>Rate</dt>
              <dd>
                {audioStats.kilobitsPerSecond === null
                  ? "-"
                  : `${audioStats.kilobitsPerSecond.toFixed(1)} kbps`}
              </dd>
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
              <dt>Lead</dt>
              <dd>{formatMs(audioStats.playoutLeadMs)}</dd>
            </div>
          </dl>
        </article>
      </section>
    </main>
  );
}
