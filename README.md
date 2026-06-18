# Shouss de Radio

Shouss de Radio is a browser-first personal radio project for synchronized
multi-device playback over the public internet.

The first technical goal is not low latency. It is a shared server timeline,
predictable playout latency, and client-side drift correction.

## Stack

- Backend: Rust, Tokio, Axum
- Frontend: TypeScript, Vite, React
- Browser audio: Web Audio API, AudioWorklet, Web Worker
- Transport v1: WebSocket control and WebSocket audio
- Transport v2: WebTransport, after the synchronization model is stable
- Audio v0: PCM/test tone for transport bring-up
- Audio v1: Opus, encoded once on the server and shared by all clients

## Repository Layout

```text
apps/
  web/                 browser client
crates/
  radio-core/          protocol and synchronization primitives
  radio-server/        public HTTP/WebSocket service
docs/
  architecture.md      system responsibilities and phases
  sync-model.md        timeline, latency, and drift model
  protocol.md          control and audio packet protocol
```

## Development

Run the backend:

```bash
cargo run -p radio-server
```

Run the frontend dev server:

```bash
cd apps/web
npm install
npm run dev
```

The Vite server proxies `/ws` and `/health` to `127.0.0.1:3000`.

## Current State

This repository currently contains the project skeleton:

- Rust workspace with `radio-core` and `radio-server`
- Axum routes for `/health`, `/ws/control`, and `/ws/audio`
- React status panel
- Web Worker clock sync loop
- AudioWorklet placeholder renderer

The next milestone is replacing the audio placeholder with timestamped PCM
packets and a browser-side jitter buffer.

## Implemented Milestones

- Git repository initialized.
- Project skeleton created.
- `/ws/control` sends session config and answers clock sync pings.
- The server loads the first `.flac` or `.wav` file in `media/tracks`.
- `/ws/audio` sends timestamped 48 kHz stereo PCM float32 packets from that
  source and loops the track.
- Browser worker receives and parses audio packets.
- AudioWorklet can play the received PCM stream through a FIFO queue.
- UI displays clock and audio transport metrics.

The current AudioWorklet playback path is for transport bring-up only. The next
audio milestone is replacing FIFO playback with timeline-aware jitter-buffer
playback.

## Media Source

Put source files in:

```text
media/tracks/
```

The current backend loads the first `.flac` or `.wav` file in that directory.
For now the source must already be:

```text
48 kHz
stereo
```

Your current FLAC source is valid:

```text
media/tracks/塞壬唱片-MSR,浅見武男 - “诺言”.flac
```
