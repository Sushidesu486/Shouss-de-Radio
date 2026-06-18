import { parseAudioPacket } from "../protocol/audioPacket";
import type { ControlMessage, WorkerCommand, WorkerEvent } from "../protocol/types";

type WorkerScope = Omit<Window, "postMessage"> & {
  postMessage(message: WorkerEvent, transfer?: Transferable[]): void;
};

const workerScope = self as unknown as WorkerScope;

let controlSocket: WebSocket | null = null;
let audioSocket: WebSocket | null = null;
let pingTimer: number | undefined;
let deviceId = "";
let audioEnabled = false;
let targetLatencyMs = 8_000;
let deviceOutputOffsetMs = 0;
const offsetSamples: Array<{ rttMs: number; clockOffsetMs: number }> = [];
let bestClockOffsetMs: number | null = null;

const audioStats = {
  packets: 0,
  bytes: 0,
  startedAtMs: 0,
  lastPostAtMs: 0,
  lastSeq: null as number | null,
  lastFirstSampleIndex: null as number | null,
  lastPayloadBytes: null as number | null,
  playoutLeadMs: null as number | null,
  lastReceiveAtMs: null as number | null,
  packetGapMs: null as number | null,
  jitterMs: null as number | null
};

const post = (event: WorkerEvent) => workerScope.postMessage(event);

const nowMs = () => performance.timeOrigin + performance.now();

const estimateClock = (
  clientSendTimeMs: number,
  serverReceiveTimeMs: number,
  serverSendTimeMs: number,
  clientReceiveTimeMs: number
) => {
  const rttMs =
    clientReceiveTimeMs -
    clientSendTimeMs -
    (serverSendTimeMs - serverReceiveTimeMs);
  const clockOffsetMs =
    (serverReceiveTimeMs -
      clientSendTimeMs +
      serverSendTimeMs -
      clientReceiveTimeMs) /
    2;

  return { rttMs, clockOffsetMs };
};

const bestOffsetEstimate = () => {
  const best = [...offsetSamples]
    .sort((left, right) => left.rttMs - right.rttMs)
    .slice(0, Math.min(8, offsetSamples.length));

  const rttMs = best.reduce((sum, sample) => sum + sample.rttMs, 0) / best.length;
  const clockOffsetMs =
    best.reduce((sum, sample) => sum + sample.clockOffsetMs, 0) / best.length;

  return { rttMs, clockOffsetMs, sampleCount: offsetSamples.length };
};

const wsUrl = (path: string) => {
  const protocol = self.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${self.location.host}${path}`;
};

const send = (message: ControlMessage) => {
  if (controlSocket?.readyState === WebSocket.OPEN) {
    controlSocket.send(JSON.stringify(message));
  }
};

const resetAudioStats = () => {
  audioStats.packets = 0;
  audioStats.bytes = 0;
  audioStats.startedAtMs = performance.now();
  audioStats.lastPostAtMs = 0;
  audioStats.lastSeq = null;
  audioStats.lastFirstSampleIndex = null;
  audioStats.lastPayloadBytes = null;
  audioStats.playoutLeadMs = null;
  audioStats.lastReceiveAtMs = null;
  audioStats.packetGapMs = null;
  audioStats.jitterMs = null;
};

const postAudioStats = () => {
  const elapsedSeconds = Math.max(
    0.001,
    (performance.now() - audioStats.startedAtMs) / 1_000
  );

  post({
    type: "audio",
    packets: audioStats.packets,
    kilobitsPerSecond: (audioStats.bytes * 8) / elapsedSeconds / 1_000,
    lastSeq: audioStats.lastSeq,
    lastFirstSampleIndex: audioStats.lastFirstSampleIndex,
    lastPayloadBytes: audioStats.lastPayloadBytes,
    playoutLeadMs: audioStats.playoutLeadMs,
    packetGapMs: audioStats.packetGapMs,
    jitterMs: audioStats.jitterMs
  });
};

const sendClockPing = () => {
  send({
    type: "clockPing",
    clientSendTimeMs: nowMs()
  });
};

const startClockSync = () => {
  self.clearInterval(pingTimer);
  sendClockPing();
  pingTimer = self.setInterval(sendClockPing, 1_000);
};

const stopClockSync = () => {
  self.clearInterval(pingTimer);
  pingTimer = undefined;
};

const closeAudioSocket = () => {
  if (audioSocket) {
    audioSocket.close();
    audioSocket = null;
  }

  postAudioStats();
};

const startAudioSocket = () => {
  if (!audioEnabled || audioSocket?.readyState === WebSocket.OPEN) {
    return;
  }

  if (controlSocket?.readyState !== WebSocket.OPEN) {
    return;
  }

  audioSocket?.close();
  audioSocket = new WebSocket(wsUrl("/ws/audio"));
  audioSocket.binaryType = "arraybuffer";
  resetAudioStats();
  postAudioStats();

  audioSocket.addEventListener("message", (event) => {
    if (!(event.data instanceof ArrayBuffer)) {
      return;
    }

    const packet = parseAudioPacket(event.data);
    if (packet === null) {
      return;
    }

    const receiveTimeMs = nowMs();
    const expectedPacketGapMs =
      (packet.header.frameCount * 1_000) / packet.header.sampleRateHz;
    const packetGapMs =
      audioStats.lastReceiveAtMs === null
        ? null
        : receiveTimeMs - audioStats.lastReceiveAtMs;
    const jitterMs =
      packetGapMs === null ? null : Math.abs(packetGapMs - expectedPacketGapMs);
    const presentationTimeMs = Number(packet.header.serverPresentationTimeNs / 1_000_000n);
    const estimatedServerNowMs =
      bestClockOffsetMs === null ? null : receiveTimeMs + bestClockOffsetMs;
    const targetPlaybackTimeMs =
      bestClockOffsetMs === null
        ? null
        : presentationTimeMs + targetLatencyMs + deviceOutputOffsetMs - bestClockOffsetMs;
    const playoutLeadMs =
      estimatedServerNowMs === null
        ? null
        : presentationTimeMs +
          targetLatencyMs +
          deviceOutputOffsetMs -
          estimatedServerNowMs;

    audioStats.packets += 1;
    audioStats.bytes += event.data.byteLength;
    audioStats.lastSeq = packet.header.seq;
    audioStats.lastFirstSampleIndex = packet.header.firstSampleIndex;
    audioStats.lastPayloadBytes = packet.header.payloadLength;
    audioStats.playoutLeadMs = playoutLeadMs;
    audioStats.lastReceiveAtMs = receiveTimeMs;
    audioStats.packetGapMs = packetGapMs;
    audioStats.jitterMs = jitterMs;

    workerScope.postMessage(
      {
        type: "audioPacket",
        payload: packet.payload,
        frameCount: packet.header.frameCount,
        channelCount: packet.header.channelCount,
        firstSampleIndex: packet.header.firstSampleIndex,
        serverPresentationTimeNs: packet.header.serverPresentationTimeNs,
        targetPlaybackTimeMs
      } satisfies WorkerEvent,
      [packet.payload]
    );

    if (performance.now() - audioStats.lastPostAtMs > 250) {
      audioStats.lastPostAtMs = performance.now();
      postAudioStats();
    }
  });

  audioSocket.addEventListener("close", () => {
    audioSocket = null;
    postAudioStats();
  });

  audioSocket.addEventListener("error", postAudioStats);
};

const connect = () => {
  if (controlSocket) {
    controlSocket.close();
  }
  closeAudioSocket();

  post({ type: "connection", state: "connecting" });
  controlSocket = new WebSocket(wsUrl("/ws/control"));
  resetAudioStats();

  controlSocket.addEventListener("open", () => {
    post({ type: "connection", state: "connected" });
    send({
      type: "hello",
      deviceId,
      userAgent: navigator.userAgent
    });
    startClockSync();
    startAudioSocket();
  });

  controlSocket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data) as ControlMessage;

    if (message.type === "clockPong") {
      const estimate = estimateClock(
        message.clientSendTimeMs,
        message.serverReceiveTimeMs,
        message.serverSendTimeMs,
        nowMs()
      );

      offsetSamples.push(estimate);
      if (offsetSamples.length > 64) {
        offsetSamples.shift();
      }

      const best = bestOffsetEstimate();
      bestClockOffsetMs = best.clockOffsetMs;
      post({ type: "clock", ...best });
      return;
    }

    if (message.type === "sessionConfig") {
      targetLatencyMs = message.targetLatencyMs;
      post({
        type: "session",
        targetLatencyMs: message.targetLatencyMs,
        sampleRateHz: message.sampleRateHz,
        sceneVersion: message.sceneVersion
      });
      return;
    }

    if (message.type === "trackInfo") {
      post({
        type: "track",
        title: message.title,
        artist: message.artist,
        filename: message.filename,
        durationMs: message.durationMs,
        sampleRateHz: message.sampleRateHz,
        channelCount: message.channelCount
      });
      return;
    }

    if (message.type === "audienceStats") {
      post({
        type: "audience",
        connectedClients: message.connectedClients,
        activeListeners: message.activeListeners,
        audioSockets: message.audioSockets
      });
    }
  });

  controlSocket.addEventListener("close", () => {
    stopClockSync();
    closeAudioSocket();
    post({ type: "connection", state: "closed" });
  });

  controlSocket.addEventListener("error", () => {
    stopClockSync();
    closeAudioSocket();
    post({ type: "connection", state: "error" });
  });
};

self.addEventListener("message", (event: MessageEvent<WorkerCommand>) => {
  if (event.data.type === "connect") {
    deviceId = event.data.deviceId;
    connect();
  }

  if (event.data.type === "disconnect") {
    audioEnabled = false;
    controlSocket?.close();
    closeAudioSocket();
    controlSocket = null;
    stopClockSync();
    post({ type: "connection", state: "idle" });
  }

  if (event.data.type === "setAudioEnabled") {
    audioEnabled = event.data.enabled;

    if (audioEnabled) {
      startAudioSocket();
    } else {
      closeAudioSocket();
    }
  }

  if (event.data.type === "setDeviceOffset") {
    deviceOutputOffsetMs = event.data.offsetMs;
  }
});
