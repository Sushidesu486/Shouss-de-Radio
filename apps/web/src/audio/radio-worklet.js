class RadioPlayerProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.enabled = false;
    this.queue = [];
    this.readOffset = 0;
    this.queuedFrames = 0;
    this.maxQueuedFrames = sampleRate * 5;

    this.port.onmessage = (event) => {
      if (event.data.type === "enabled") {
        this.enabled = event.data.enabled;
        if (!this.enabled) {
          this.queue = [];
          this.readOffset = 0;
          this.queuedFrames = 0;
        }
      }

      if (event.data.type === "pcmPacket" && this.enabled) {
        this.queue.push({
          samples: new Float32Array(event.data.payload),
          frameCount: event.data.frameCount,
          channelCount: event.data.channelCount,
          firstSampleIndex: event.data.firstSampleIndex,
          serverPresentationTimeNs: event.data.serverPresentationTimeNs
        });
        this.queuedFrames += event.data.frameCount;
        this.dropOverflow();
      }
    };
  }

  dropOverflow() {
    while (this.queuedFrames > this.maxQueuedFrames && this.queue.length > 1) {
      const dropped = this.queue.shift();
      this.queuedFrames -= dropped.frameCount;
      this.readOffset = 0;
    }
  }

  nextFrame() {
    while (this.queue.length > 0) {
      const packet = this.queue[0];
      const frameOffset = this.readOffset * packet.channelCount;

      if (this.readOffset < packet.frameCount) {
        const left = packet.samples[frameOffset] ?? 0;
        const right =
          packet.channelCount > 1 ? packet.samples[frameOffset + 1] ?? left : left;
        this.readOffset += 1;
        return [left, right];
      }

      this.queue.shift();
      this.queuedFrames -= packet.frameCount;
      this.readOffset = 0;
    }

    return [0, 0];
  }

  process(_inputs, outputs) {
    const output = outputs[0];

    for (let frame = 0; frame < output[0].length; frame += 1) {
      const [left, right] = this.enabled ? this.nextFrame() : [0, 0];

      if (output.length > 0) {
        output[0][frame] = left;
      }
      if (output.length > 1) {
        output[1][frame] = right;
      }
    }

    return true;
  }
}

registerProcessor("radio-player", RadioPlayerProcessor);
