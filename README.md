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
- The server loads `.flac` and `.wav` files in `media/tracks` as a sorted
  playlist.
- `/ws/audio` sends timestamped 48 kHz stereo 16-bit PCM packets from that
  playlist and loops the playlist.
- Browser worker receives and parses audio packets.
- AudioWorklet plays packets by stream sample timeline through a jitter buffer.
- UI displays clock, audio transport, sync quality, and device offset metrics.

## Media Source

Put source files in:

```text
media/tracks/
```

The current backend loads `.flac` and `.wav` files in that directory as a
sorted playlist, then loops the playlist.
For now the source must already be:

```text
48 kHz
stereo
```
