# Architecture

## Product Direction

Shouss de Radio is a public-internet personal radio system. A single source is
distributed to browsers, and each browser can render a different role in a
simulated multi-device sound field.

The server owns the global timeline. Clients own local timing, buffering,
playback correction, and device-specific rendering.

## Server Responsibilities

- Serve the web app over HTTPS in production.
- Maintain authoritative server time and stream sample timeline.
- Load `.flac` and `.wav` files in `media/tracks` as a sorted looping playlist.
- Decode source audio into a cached 48 kHz stereo float32 timeline.
- Send the public stream as 16-bit PCM packets to reduce tunnel bandwidth.
- Encode the shared stream once, then broadcast the same packets to clients.
- Attach sequence, sample index, and presentation time to every audio packet.
- Accept client health reports: RTT, offset, buffer, underruns, drift.
- Coordinate session-level `targetLatencyMs`.
- Broadcast scene metadata: device role, gain, delay, calibration.

The server should not generate per-client audio unless a future feature
explicitly needs it.

## Client Responsibilities

- Estimate server clock offset with an NTP-like exchange.
- Maintain packet ordering and a jitter buffer.
- Decode Opus or PCM packets.
- Map server timeline to local `AudioContext` time.
- Keep actual end-to-end latency close to `targetLatencyMs`.
- Apply drift correction with a light resampler.
- Apply role-specific rendering: left, right, center, sub, rear, ambience.
- Report health metrics back to the server.

## Runtime Threads

```text
Main thread
  React UI, session state, controls

Web Worker
  WebSocket/WebTransport, clock sync, packet queue, decoder

AudioWorklet
  realtime ring-buffer read, gain, delay, resampling, output
```

## Phases

1. Bring up WebSocket control and timestamped PCM packets from `media/tracks`.
2. Use browser-side jitter buffer and timeline-aware AudioWorklet playback.
3. Add fixed target latency and multi-browser synchronized start.
4. Add PI-controller drift correction and light resampling.
5. Add Opus encoding/decoding.
6. Add role-based rendering and manual latency calibration.
7. Add WebTransport and optional edge relay support.

## Reference Projects

- Roc Toolkit: timestamp mapping, fixed latency, PI controller, resampler.
- Snapcast: multiroom client/server model with timestamped chunks.
- Shairport Sync: source clock, local clock, audio device clock, resampling.
- soundworks: browser-based distributed music application structure.
