export type ControlMessage =
  | {
      type: "hello";
      deviceId: string;
      userAgent: string;
    }
  | {
      type: "clockPing";
      clientSendTimeMs: number;
    }
  | {
      type: "clockPong";
      clientSendTimeMs: number;
      serverReceiveTimeMs: number;
      serverSendTimeMs: number;
    }
  | {
      type: "sessionConfig";
      targetLatencyMs: number;
      sampleRateHz: number;
      sceneVersion: number;
    }
  | {
      type: "trackInfo";
      title: string;
      artist: string | null;
      filename: string;
      durationMs: number;
      sampleRateHz: number;
      channelCount: number;
    }
  | {
      type: "audienceStats";
      connectedClients: number;
      activeListeners: number;
      audioSockets: number;
    }
  | {
      type: "clientStatus";
      rttMs: number;
      clockOffsetMs: number;
      bufferMs: number;
      playbackErrorMs: number;
      resampleRatio: number;
      underruns: number;
    };

export type WorkerCommand =
  | { type: "connect"; deviceId: string }
  | { type: "disconnect" }
  | { type: "setAudioEnabled"; enabled: boolean };

export type WorkerEvent =
  | {
      type: "connection";
      state: "idle" | "connecting" | "connected" | "closed" | "error";
    }
  | {
      type: "clock";
      rttMs: number;
      clockOffsetMs: number;
      sampleCount: number;
    }
  | {
      type: "session";
      targetLatencyMs: number;
      sampleRateHz: number;
      sceneVersion: number;
    }
  | {
      type: "track";
      title: string;
      artist: string | null;
      filename: string;
      durationMs: number;
      sampleRateHz: number;
      channelCount: number;
    }
  | {
      type: "audience";
      connectedClients: number;
      activeListeners: number;
      audioSockets: number;
    }
  | {
      type: "audio";
      packets: number;
      kilobitsPerSecond: number | null;
      lastSeq: number | null;
      lastFirstSampleIndex: number | null;
      lastPayloadBytes: number | null;
      playoutLeadMs: number | null;
      packetGapMs: number | null;
      jitterMs: number | null;
    }
  | {
      type: "audioPacket";
      payload: ArrayBuffer;
      frameCount: number;
      channelCount: number;
      firstSampleIndex: number;
      serverPresentationTimeNs: bigint;
    };
