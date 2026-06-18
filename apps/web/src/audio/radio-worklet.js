const CHANNELS = 2;
const STATS_INTERVAL_FRAMES = 24_000;
const DEFAULT_SOURCE_SAMPLE_RATE = 48_000;
const MAX_BUFFER_SECONDS = 20;
const HISTORY_SECONDS = 2;
const SNAP_THRESHOLD_SECONDS = 0.2;
const ANCHOR_RESET_THRESHOLD_SECONDS = 0.5;
const ANCHOR_SMOOTHING = 0.02;
const MAX_INTEGRAL_SECONDS = 0.25;
const MIN_PLAYBACK_RATIO = 0.999;
const MAX_PLAYBACK_RATIO = 1.001;
const KP = 0.0000012;
const KI = 0.0000000008;
const PULSE_INTERVAL_SECONDS = 1;
const PULSE_LENGTH_SECONDS = 0.012;
const PULSE_FREQUENCY_HZ = 880;
const PULSE_GAIN = 0.28;

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

class RadioPlayerProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.enabled = false;
    this.packets = new Map();
    this.packetFrames = 0;
    this.sourceSampleRate = DEFAULT_SOURCE_SAMPLE_RATE;
    this.sourceFramesPerContextFrame = this.sourceSampleRate / sampleRate;
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
    this.anchorErrorFrames = 0;
    this.calibrationPulseEnabled = false;
    this.lastRenderedSampleIndex = null;

    this.port.onmessage = (event) => {
      if (event.data.type === "enabled") {
        this.enabled = event.data.enabled;
        this.reset();
        return;
      }

      if (event.data.type === "timelinePacket" && this.enabled) {
        this.insertPacket(event.data);
        return;
      }

      if (event.data.type === "calibrationPulse") {
        this.calibrationPulseEnabled = event.data.enabled;
      }
    };
  }

  reset() {
    this.packets.clear();
    this.packetFrames = 0;
    this.sourceSampleRate = DEFAULT_SOURCE_SAMPLE_RATE;
    this.sourceFramesPerContextFrame = this.sourceSampleRate / sampleRate;
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
    this.anchorErrorFrames = 0;
    this.lastRenderedSampleIndex = null;
  }

  updateAnchor(packet) {
    const nextAnchor = {
      sampleIndex: packet.firstSampleIndex,
      contextFrame: packet.targetContextFrame
    };

    if (this.anchor === null) {
      this.anchor = nextAnchor;
      this.anchorErrorFrames = 0;
      return;
    }

    const predictedSampleIndex = this.targetSampleIndexAt(packet.targetContextFrame);
    const anchorErrorFrames = packet.firstSampleIndex - predictedSampleIndex;
    this.anchorErrorFrames = anchorErrorFrames;

    if (
      Math.abs(anchorErrorFrames) >
      this.sourceSampleRate * ANCHOR_RESET_THRESHOLD_SECONDS
    ) {
      this.anchor = nextAnchor;
      this.playhead = null;
      this.integralErrorFrames = 0;
      this.resyncs += 1;
      return;
    }

    this.anchor = {
      sampleIndex: this.anchor.sampleIndex + anchorErrorFrames * ANCHOR_SMOOTHING,
      contextFrame: this.anchor.contextFrame
    };
  }

  insertPacket(packet) {
    if (packet.frameCount <= 0 || packet.channelCount <= 0) {
      return;
    }

    const nextSourceSampleRate = packet.sampleRateHz || DEFAULT_SOURCE_SAMPLE_RATE;
    if (nextSourceSampleRate !== this.sourceSampleRate) {
      this.sourceSampleRate = nextSourceSampleRate;
      this.sourceFramesPerContextFrame = this.sourceSampleRate / sampleRate;
      this.anchor = null;
      this.playhead = null;
      this.integralErrorFrames = 0;
      this.resyncs += 1;
    }

    this.packetFrames = packet.frameCount;
    this.updateAnchor(packet);

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

    return (
      this.anchor.sampleIndex +
      (contextFrame - this.anchor.contextFrame) * this.sourceFramesPerContextFrame
    );
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

    const dropBefore = referenceSampleIndex - this.sourceSampleRate * HISTORY_SECONDS;
    for (const [firstSampleIndex, packet] of this.packets) {
      if (firstSampleIndex + packet.frameCount < dropBefore) {
        this.packets.delete(firstSampleIndex);
      }
    }

    const maxPackets = Math.ceil(
      (this.sourceSampleRate * MAX_BUFFER_SECONDS) / Math.max(1, this.packetFrames)
    );
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

    if (
      this.playhead === null ||
      Math.abs(targetSampleIndex - this.playhead) >
        this.sourceSampleRate * SNAP_THRESHOLD_SECONDS
    ) {
      this.playhead = targetSampleIndex;
      this.lastRenderedSampleIndex = targetSampleIndex;
      this.integralErrorFrames = 0;
      this.playbackRatio = 1;
      this.resyncs += 1;
    }

    const errorFrames = targetSampleIndex - this.playhead;
    this.integralErrorFrames = clamp(
      this.integralErrorFrames + errorFrames,
      -this.sourceSampleRate * MAX_INTEGRAL_SECONDS,
      this.sourceSampleRate * MAX_INTEGRAL_SECONDS
    );
    const correction = errorFrames * KP + this.integralErrorFrames * KI;
    this.playbackRatio = clamp(
      1 + correction,
      MIN_PLAYBACK_RATIO,
      MAX_PLAYBACK_RATIO
    );

    const renderedSampleIndex = this.playhead;
    const frame = this.interpolatedFrame(renderedSampleIndex);
    this.playhead += this.sourceFramesPerContextFrame * this.playbackRatio;

    if (frame === null) {
      if (!this.missing && targetSampleIndex >= start && targetSampleIndex < end) {
        this.underruns += 1;
      }
      this.missing = true;
      this.lastRenderedSampleIndex = targetSampleIndex;
      return [0, 0];
    }

    this.missing = false;
    this.lastRenderedSampleIndex = renderedSampleIndex;
    return frame;
  }

  calibrationPulse(sampleIndex) {
    if (!this.calibrationPulseEnabled || sampleIndex === null) {
      return 0;
    }

    const pulseIntervalFrames = Math.round(
      this.sourceSampleRate * PULSE_INTERVAL_SECONDS
    );
    const pulseLengthFrames = Math.round(
      this.sourceSampleRate * PULSE_LENGTH_SECONDS
    );
    const phaseFrame = Math.floor(sampleIndex) % pulseIntervalFrames;
    if (phaseFrame >= pulseLengthFrames) {
      return 0;
    }

    const envelope = 1 - phaseFrame / pulseLengthFrames;
    const phase =
      (2 * Math.PI * PULSE_FREQUENCY_HZ * phaseFrame) / this.sourceSampleRate;
    return Math.sin(phase) * envelope * PULSE_GAIN;
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
        : ((this.playhead - targetSampleIndex) * 1000) / this.sourceSampleRate;
    const bufferLeadMs =
      targetSampleIndex === null || end === null
        ? null
        : ((end - targetSampleIndex) * 1000) / this.sourceSampleRate;

    this.port.postMessage({
      type: "syncStats",
      syncErrorMs,
      bufferLeadMs,
      playbackRatio: this.playbackRatio,
      anchorErrorMs: (this.anchorErrorFrames * 1000) / this.sourceSampleRate,
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
      let [left, right] = this.enabled
        ? this.nextFrame(currentFrame + frame)
        : [0, 0];
      const pulse = this.calibrationPulse(this.lastRenderedSampleIndex);
      left += pulse;
      right += pulse;

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
