# Synchronization Model

## Goal

All clients play the same stream timeline with the same target end-to-end
latency. On the public internet, the system favors stability over low latency.

Initial public-internet target:

```text
targetLatencyMs = 8000
```

This can later be lowered for stable clients or raised for weak networks.

## Timeline Terms

The model borrows the useful parts of Roc Toolkit's timestamp vocabulary:

```text
STS: stream timestamp, represented as sample index
CTS: capture/presentation timestamp, represented as server time
RTS: receive timestamp, measured by the browser worker
QTS: queue timestamp, measured when the packet enters the audio queue
```

In this project:

```text
firstSampleIndex
serverPresentationTimeNs
clientReceiveTimeMs
clientQueueTimeMs
```

are the main synchronization facts.

## Clock Sync

The browser sends:

```text
clientSendTimeMs
```

The server responds with:

```text
clientSendTimeMs
serverReceiveTimeMs
serverSendTimeMs
```

The browser records:

```text
clientReceiveTimeMs
```

The estimate is:

```text
rttMs = (clientReceiveTimeMs - clientSendTimeMs)
  - (serverSendTimeMs - serverReceiveTimeMs)

clockOffsetMs = (
  (serverReceiveTimeMs - clientSendTimeMs)
  + (serverSendTimeMs - clientReceiveTimeMs)
) / 2
```

Clients keep a rolling window and prefer the lowest-RTT samples, because those
are least polluted by public-internet queueing delay.

## Playout Position

For a client with a current estimate of server time:

```text
sourceTimeMs = estimatedServerNowMs - targetLatencyMs
expectedSampleIndex = floor(sourceTimeMs * sampleRateHz / 1000)
```

The AudioWorklet should render samples aligned with `expectedSampleIndex`, not
with packet arrival time.

## Current Transport Milestone

The server now sends decoded 48 kHz stereo PCM from the sorted playlist in
`media/tracks` on a global stream timeline. Each browser connection receives
packets near the current stream position, rather than starting a private sample
index at zero. The playlist loops when the stream timeline passes the total
playlist length.

This allows the next milestone to focus on:

```text
packet queue
jitter buffer
serverPresentationTimeNs + targetLatencyMs scheduling
AudioWorklet ring-buffer playback
```

The current AudioWorklet path stores packets by `firstSampleIndex` and maps
`serverPresentationTimeNs + targetLatencyMs + deviceOutputOffsetMs` to an
AudioContext frame. Playback is driven by the stream timeline rather than FIFO
arrival order.

## Drift Correction

The browser continuously compares:

```text
actual playback position
expected playback position
```

Small error is corrected by adjusting playback ratio:

```text
0.999 <= playbackRatio <= 1.001
```

The current implementation uses linear interpolation in AudioWorklet. It also
accounts for browsers whose actual AudioContext sample rate differs from the
48 kHz stream sample rate.

## Device Calibration

Each browser stores a local `deviceOutputOffsetMs`. Positive values delay that
device and negative values advance it. The calibration pulse is generated from
the stream sample timeline, so two devices can be matched by ear before any
future automatic microphone-based calibration.

## Recovery

If the buffer underruns, the client should report it and recover locally. If
many clients report late packets, the server should raise `targetLatencyMs` for
the whole session.
