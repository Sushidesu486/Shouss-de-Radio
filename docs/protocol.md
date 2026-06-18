# Protocol

## Endpoints

```text
GET /health
GET /ws/control
GET /ws/audio
```

Control messages use JSON. Audio packets will use a binary header followed by
PCM or Opus payload.

## Control Messages

Messages use a `type` field with camelCase names.

### hello

```json
{
  "type": "hello",
  "deviceId": "device-uuid",
  "deviceName": "MacBook Left",
  "userAgent": "browser user agent"
}
```

### clockPing

```json
{
  "type": "clockPing",
  "clientSendTimeMs": 1781700000000.123
}
```

### clockPong

```json
{
  "type": "clockPong",
  "clientSendTimeMs": 1781700000000.123,
  "serverReceiveTimeMs": 1781700000042.100,
  "serverSendTimeMs": 1781700000042.250
}
```

### sessionConfig

```json
{
  "type": "sessionConfig",
  "targetLatencyMs": 8000,
  "sampleRateHz": 48000,
  "sceneVersion": 0
}
```

### clientStatus

```json
{
  "type": "clientStatus",
  "rttMs": 84.2,
  "clockOffsetMs": -12.4,
  "bufferMs": 7200,
  "playbackErrorMs": 1.7,
  "playbackErrorP95Ms": 4.2,
  "playbackErrorMaxMs": 8.8,
  "resampleRatio": 1.00003,
  "underruns": 0,
  "lateDrops": 0,
  "resyncs": 1,
  "deviceOutputOffsetMs": -12
}
```

## Diagnostics

```text
GET /api/clients
```

Returns the current in-memory status for connected control clients. This is used
to compare multi-device playback quality while tuning for 10 ms-class sync.
Each client entry includes `deviceName` when the browser has configured a custom
display name.

## Audio Packet v0

The current audio milestone uses PCM packets decoded from the sorted `.flac` and
`.wav` playlist in `media/tracks`:

```text
48 kHz
stereo
20 ms packet
960 frames per packet
codec = pcm_s16
```

The binary header uses big-endian integer fields:

```text
magic                       4 bytes
version                     1 byte
codec                       1 byte
flags                       2 bytes
seq                         8 bytes
firstSampleIndex            8 bytes
frameCount                  4 bytes
sampleRateHz                4 bytes
channelCount                2 bytes
serverPresentationTimeNs   16 bytes
payloadLength               4 bytes
payload                     N bytes
```

Current constants:

```text
magic = "SRAD"
version = 1
codec pcm_f32 = 1
codec opus = 2
codec pcm_s16 = 3
header length = 54 bytes
```

Current PCM payload uses interleaved little-endian signed 16-bit samples:

```text
left0, right0, left1, right1, ...
```

The browser worker converts `pcm_s16` payloads to Float32Array before passing
them to the AudioWorklet. Older `pcm_f32` payloads are still parseable.

The browser must schedule by `firstSampleIndex` and
`serverPresentationTimeNs`, not by receive time.
