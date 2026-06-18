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

The server now sends decoded 48 kHz stereo PCM from the first track in
`media/tracks` on a global stream timeline. Each browser connection receives
packets near the current stream position, rather than starting a private sample
index at zero. The track loops when the stream timeline passes the file length.

This allows the next milestone to focus on:

```text
packet queue
jitter buffer
serverPresentationTimeNs + targetLatencyMs scheduling
AudioWorklet ring-buffer playback
```

The current AudioWorklet path plays received PCM packets in FIFO order. That is
intentional for transport bring-up, but it is not yet synchronized playback.

## Drift Correction

The browser continuously compares:

```text
actual playback position
expected playback position
```

Small error is corrected by adjusting playback ratio:

```text
0.9999 <= playbackRatio <= 1.0001
```

The first implementation can use linear interpolation. Later versions can move
the resampler into WASM if quality or CPU usage requires it.

## Recovery

If the buffer underruns, the client should report it and recover locally. If
many clients report late packets, the server should raise `targetLatencyMs` for
the whole session.
