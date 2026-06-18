const CHANNELS = 2;
const STATS_INTERVAL_FRAMES = 24_000;
const MAX_BUFFER_FRAMES = sampleRate * 20;
const HISTORY_FRAMES = sampleRate * 2;
const SNAP_THRESHOLD_FRAMES = sampleRate * 0.2;
const MAX_INTEGRAL_FRAMES = sampleRate * 0.25;
const MIN_PLAYBACK_RATIO = 0.999;
const MAX_PLAYBACK_RATIO = 1.001;
const KP = 0.0000012;
const KI = 0.0000000008;

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

class RadioPlayerProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.enabled = false;
    this.packets = new Map();
    this.packetFrames = 0;
    this.anchor = null;
    this.playhead = null;
    this.bufferStart = null;
    this.bufferEnd = null;
    this.integralErrorFrames = 0;
    this.playbackRatio = 1;
    this.underruns = 0;
    this.lateDrops = 0;
    this.resyncs = 0;
    this.missing = false;
    this.lastStatsFrame = 0;

    this.port.onmessage = (event) => {
      if (event.data.type === "enabled") {
        this.enabled = event.data.enabled;
        this.reset();
        return;
      }

      if (event.data.type === "timelinePacket" && this.enabled) {
        this.insertPacket(event.data);
      }
    };
  }

  reset() {
    this.packets.clear();
    this.packetFrames = 0;
    this.anchor = null;
    this.playhead = null;
    this.bufferStart = null;
    this.bufferEnd = null;
    this.integralErrorFrames = 0;
    this.playbackRatio = 1;
    this.underruns = 0;
    this.lateDrops = 0;
    this.resyncs = 0;
    this.missing = false;
  }

  insertPacket(packet) {
    if (packet.frameCount <= 0 || packet.channelCount <= 0) {
      return;
    }

    this.packetFrames = packet.frameCount;
    this.anchor = {
      sampleIndex: packet.firstSampleIndex,
      contextFrame: packet.targetContextFrame
    };

    if (packet.targetContextFrame + packet.frameCount < currentFrame) {
      this.lateDrops += 1;
      return;
    }

    this.packets.set(packet.firstSampleIndex, {
      samples: new Float32Array(packet.payload),
      frameCount: packet.frameCount,
      channelCount: packet.channelCount
    });

    this.dropOldPackets(this.targetSampleIndexAt(currentFrame));
    this.recomputeBufferedRange();
  }

  targetSampleIndexAt(contextFrame) {
    if (this.anchor === null) {
      return null;
    }

    return this.anchor.sampleIndex + (contextFrame - this.anchor.contextFrame);
  }

  packetStartFor(sampleIndex) {
    if (this.packetFrames <= 0) {
      return null;
    }

    return Math.floor(sampleIndex / this.packetFrames) * this.packetFrames;
  }

  sampleAt(sampleIndex, channel) {
    const packetStart = this.packetStartFor(sampleIndex);
    if (packetStart === null) {
      return null;
    }

    const packet = this.packets.get(packetStart);
    if (!packet) {
      return null;
    }

    const offset = sampleIndex - packetStart;
    if (offset < 0 || offset >= packet.frameCount) {
      return null;
    }

    const sourceChannel = Math.min(channel, packet.channelCount - 1);
    return packet.samples[offset * packet.channelCount + sourceChannel] ?? 0;
  }

  interpolatedFrame(sampleIndex) {
    const lower = Math.floor(sampleIndex);
    const fraction = sampleIndex - lower;

    const leftA = this.sampleAt(lower, 0);
    const rightA = this.sampleAt(lower, 1);
    if (leftA === null || rightA === null) {
      return null;
    }

    const leftB = this.sampleAt(lower + 1, 0);
    const rightB = this.sampleAt(lower + 1, 1);
    if (leftB === null || rightB === null) {
      return [leftA, rightA];
    }

    return [
      leftA + (leftB - leftA) * fraction,
      rightA + (rightB - rightA) * fraction
    ];
  }

  recomputeBufferedRange() {
    this.bufferStart = null;
    this.bufferEnd = null;

    for (const [firstSampleIndex, packet] of this.packets) {
      this.bufferStart =
        this.bufferStart === null
          ? firstSampleIndex
          : Math.min(this.bufferStart, firstSampleIndex);
      this.bufferEnd =
        this.bufferEnd === null
          ? firstSampleIndex + packet.frameCount
          : Math.max(this.bufferEnd, firstSampleIndex + packet.frameCount);
    }
  }

  dropOldPackets(referenceSampleIndex) {
    if (referenceSampleIndex === null) {
      return;
    }

    const dropBefore = referenceSampleIndex - HISTORY_FRAMES;
    for (const [firstSampleIndex, packet] of this.packets) {
      if (firstSampleIndex + packet.frameCount < dropBefore) {
        this.packets.delete(firstSampleIndex);
      }
    }

    const maxPackets = Math.ceil(MAX_BUFFER_FRAMES / Math.max(1, this.packetFrames));
    if (this.packets.size <= maxPackets) {
      return;
    }

    const starts = [...this.packets.keys()].sort((left, right) => left - right);
    for (const start of starts.slice(0, this.packets.size - maxPackets)) {
      this.packets.delete(start);
    }
  }

  nextFrame(contextFrame) {
    const targetSampleIndex = this.targetSampleIndexAt(contextFrame);
    if (targetSampleIndex === null) {
      return [0, 0];
    }

    const start = this.bufferStart;
    const end = this.bufferEnd;
    if (start === null || end === null || targetSampleIndex < start) {
      return [0, 0];
    }

    if (this.playhead === null || Math.abs(targetSampleIndex - this.playhead) > SNAP_THRESHOLD_FRAMES) {
      this.playhead = targetSampleIndex;
      this.integralErrorFrames = 0;
      this.playbackRatio = 1;
      this.resyncs += 1;
    }

    const errorFrames = targetSampleIndex - this.playhead;
    this.integralErrorFrames = clamp(
      this.integralErrorFrames + errorFrames,
      -MAX_INTEGRAL_FRAMES,
      MAX_INTEGRAL_FRAMES
    );
    const correction = errorFrames * KP + this.integralErrorFrames * KI;
    this.playbackRatio = clamp(
      1 + correction,
      MIN_PLAYBACK_RATIO,
      MAX_PLAYBACK_RATIO
    );

    const frame = this.interpolatedFrame(this.playhead);
    this.playhead += this.playbackRatio;

    if (frame === null) {
      if (!this.missing && targetSampleIndex >= start && targetSampleIndex < end) {
        this.underruns += 1;
      }
      this.missing = true;
      return [0, 0];
    }

    this.missing = false;
    return frame;
  }

  postStats(contextFrame) {
    if (contextFrame - this.lastStatsFrame < STATS_INTERVAL_FRAMES) {
      return;
    }
    this.lastStatsFrame = contextFrame;

    const targetSampleIndex = this.targetSampleIndexAt(contextFrame);
    const end = this.bufferEnd;
    const syncErrorMs =
      targetSampleIndex === null || this.playhead === null
        ? null
        : ((this.playhead - targetSampleIndex) * 1000) / sampleRate;
    const bufferLeadMs =
      targetSampleIndex === null || end === null
        ? null
        : ((end - targetSampleIndex) * 1000) / sampleRate;

    this.port.postMessage({
      type: "syncStats",
      syncErrorMs,
      bufferLeadMs,
      playbackRatio: this.playbackRatio,
      underruns: this.underruns,
      lateDrops: this.lateDrops,
      resyncs: this.resyncs,
      queuedPackets: this.packets.size
    });
  }

  process(_inputs, outputs) {
    const output = outputs[0];
    const channelCount = Math.min(output.length, CHANNELS);

    for (let frame = 0; frame < output[0].length; frame += 1) {
      const [left, right] = this.enabled
        ? this.nextFrame(currentFrame + frame)
        : [0, 0];

      if (channelCount > 0) {
        output[0][frame] = left;
      }
      if (channelCount > 1) {
        output[1][frame] = right;
      }
    }

    this.postStats(currentFrame);
    return true;
  }
}

registerProcessor("radio-player", RadioPlayerProcessor);
