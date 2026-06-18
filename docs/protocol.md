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
  "resampleRatio": 1.00003,
  "underruns": 0
}
```

## Audio Packet v0

The current audio milestone uses PCM packets decoded from the first `.flac` or
`.wav` file in `media/tracks`:

```text
48 kHz
stereo
20 ms packet
960 frames per packet
codec = pcm_f32
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
header length = 54 bytes
```

PCM payload uses interleaved little-endian `float32` samples:

```text
left0, right0, left1, right1, ...
```

The browser must schedule by `firstSampleIndex` and
`serverPresentationTimeNs`, not by receive time.
