export const AUDIO_PACKET_HEADER_LEN = 54;

export type AudioCodec = "pcm_f32" | "pcm_s16" | "opus";

export type AudioPacketHeader = {
  codec: AudioCodec;
  seq: number;
  firstSampleIndex: number;
  frameCount: number;
  sampleRateHz: number;
  channelCount: number;
  serverPresentationTimeNs: bigint;
  payloadLength: number;
};

export type ParsedAudioPacket = {
  header: AudioPacketHeader;
  payload: ArrayBuffer;
};

const MAGIC = [0x53, 0x52, 0x41, 0x44];
const VERSION = 1;

const codecFromWire = (value: number): AudioCodec | null => {
  if (value === 1) {
    return "pcm_f32";
  }

  if (value === 2) {
    return "opus";
  }

  if (value === 3) {
    return "pcm_s16";
  }

  return null;
};

const readI128 = (view: DataView, offset: number) => {
  const high = view.getBigUint64(offset);
  const low = view.getBigUint64(offset + 8);
  const unsigned = (high << 64n) | low;
  const signBit = 1n << 127n;

  if ((unsigned & signBit) === 0n) {
    return unsigned;
  }

  return unsigned - (1n << 128n);
};

export const parseAudioPacket = (buffer: ArrayBuffer): ParsedAudioPacket | null => {
  if (buffer.byteLength < AUDIO_PACKET_HEADER_LEN) {
    return null;
  }

  const view = new DataView(buffer);

  for (let index = 0; index < MAGIC.length; index += 1) {
    if (view.getUint8(index) !== MAGIC[index]) {
      return null;
    }
  }

  if (view.getUint8(4) !== VERSION) {
    return null;
  }

  const codec = codecFromWire(view.getUint8(5));
  if (codec === null) {
    return null;
  }

  const payloadLength = view.getUint32(50);
  if (AUDIO_PACKET_HEADER_LEN + payloadLength !== buffer.byteLength) {
    return null;
  }

  return {
    header: {
      codec,
      seq: Number(view.getBigUint64(8)),
      firstSampleIndex: Number(view.getBigUint64(16)),
      frameCount: view.getUint32(24),
      sampleRateHz: view.getUint32(28),
      channelCount: view.getUint16(32),
      serverPresentationTimeNs: readI128(view, 34),
      payloadLength
    },
    payload: buffer.slice(AUDIO_PACKET_HEADER_LEN)
  };
};
