# BloomRecord

A fully local screen recorder for Windows, macOS and Linux, inspired by Loom. Record your screen or a window together with your webcam (as a circular bubble) and microphone, then trim and export MP4s. No account, no cloud, no network access.

> **Privacy:** recordings, thumbnails, the library database and settings never leave your computer. BloomRecord makes no network requests: no account, no uploads, no license checks, no analytics or telemetry. The camera, microphone and screen are only accessed while you set up or make a recording.

## Install (Windows)

**[⬇ Download BloomRecord-Setup-0.1.0-x64.exe](installer/BloomRecord-Setup-0.1.0-x64.exe)** (Windows 10/11, 64-bit, about 195 MB)

Run the downloaded file. It installs to `%LocalAppData%\bloomrecord` without asking for admin rights, adds Start Menu and desktop shortcuts, and launches the app. To uninstall, use Windows Settings → Apps.

The installer is unsigned, so Windows SmartScreen will warn on first run: choose **More info → Run anyway**.

For maintainers: `npm run make` rebuilds the installer and copies it into `installer/` (see [Building releases](#building-releases)). When you bump the version in `package.json`, update the link above to the new filename.

## Features

- Screen + camera, screen only, or camera only recording; pick any screen or window
- Circular, aspect-correct webcam bubble (S/M/L, any corner) composited into the final MP4
- Microphone plus system audio (Windows), mixed without clipping
- Pause / resume / stop, a countdown, and global shortcuts (`Ctrl/⌘+Shift+9` pause, `Ctrl/⌘+Shift+0` stop)
- Data written to disk progressively; interrupted sessions (crash, power loss, quitting) can be recovered
- Library with search, sort, rename, delete (to trash), reveal in folder, and detection of missing files
- Player with frame-accurate or fast (stream copy) trimming; save to library, Save As, or replace the original (only after confirmation)
- Background processing jobs with progress, cancel and retry
- Light and dark themes; all settings persisted locally

## Architecture

```
┌──────────────── Renderer (React, sandboxed, no Node) ────────────────┐
│ UI · MediaRecorder per track (screen, camera, mic, system audio)    │
│ getDisplayMedia / getUserMedia · chunks every 1s → IPC              │
└───────────────▲──────────────────────────────┬───────────────────────┘
                │ window.bloom (typed, narrow)  │
┌───────────────┴─────── Preload (contextBridge, fixed channels) ──────┐
└───────────────▲──────────────────────────────┬───────────────────────┘
                │ IpcResult envelope            │ Zod-validated requests
┌───────────────┴──────────── Main process (Node) ─────────────────────┐
│ ipc/        sender check + Zod validation + error mapping            │
│ recording/  session state machine, TrackWriter (append to disk),     │
│             recovery manifest                                        │
│ media/      FFmpeg/FFprobe runner, compose (filter graphs), trim,    │
│             thumbnails, verification, JobManager (cancel/retry)      │
│ library/    library & export services, bloom-media:// streaming      │
│ storage/    SQLite + Drizzle, migrations, settings, cleanup          │
│ capture/    desktopCapturer sources, display-media broker,           │
│             per-OS CapturePlatform (permissions, loopback audio)     │
│ security/   CSP, app:// protocol, permission handlers, path guard    │
└──────────────────────────────────────────────────────────────────────┘
```

**Recording pipeline.**
1. The renderer asks main which source to capture (`capture:prepare-source`), then calls `getDisplayMedia()`. Main's display-media handler hands Chromium exactly that source, plus WASAPI loopback audio on Windows.
2. Each track gets its own `MediaRecorder` (codec chosen at runtime: VP8 / VP9 / H.264 WebM, or MP4). All recorders start in the same task, and each one's actual start offset is reported to main.
3. Every second, chunks are sent to main and appended to `<userData>/sessions/<id>/<track>.webm`. Free space is checked as recording continues. Session state lives in SQLite and in an atomically written `manifest.json`.
4. On stop, a **compose job** inspects each track with FFprobe, measures real durations, and builds a filter graph:
   - Screen → constant frame rate → scaled and padded to the output size.
   - Camera → aligned by start offset → centre-cropped square → anti-aliased circular alpha mask (`alphamerge`) → overlaid in the chosen corner.
   - Mic and system audio → resampled with async drift correction → aligned → `amix` (`normalize=0`) → `alimiter`.
   - Output is H.264/AAC MP4 with `+faststart`, written to a hidden `.partial` file, verified with FFprobe, then renamed into place.
   - Raw tracks are deleted only after verification succeeds.
5. Failed or cancelled processing keeps the raw tracks; the library offers **Retry**.

**Pause/resume:** all recorders pause together and MediaRecorder's timeline excludes the paused time, so tracks stay aligned. Pause intervals are also recorded per session.

**Recovery:** at startup, sessions left `recording`, `paused`, `stopping` or `processing` become `interrupted`. Orphaned session folders with a valid manifest are re-imported, and recordings stuck in `processing` become `failed`. The dashboard lists recoverable sessions with **Recover** / **Discard**.

## Project layout

```
electron/   main.ts, preload.ts, app-context.ts (composition root)
  ipc/ capture/ recording/ media/ library/ storage/ security/
src/        React renderer: app/, components/{dashboard,recorder,library,player,editor,settings,ui,layout},
            hooks/, services/ (bloom bridge, recorder-controller, media devices), stores/ (Zustand), styles/
shared/     ipc-contracts.ts, recording-types.ts, validation.ts (Zod), recording-state.ts, trim.ts
tests/      unit/, integration/ (real FFmpeg + SQLite), e2e/ (Playwright + Electron)
resources/  icons/, ffmpeg/ (binaries for the build target, populated by scripts/prepare-ffmpeg.mjs)
scripts/    prepare-ffmpeg.mjs, generate-icons.mjs
```

## Development

Requirements: Node.js 22+ and npm. No system FFmpeg is needed: `npm install` copies the bundled FFmpeg/FFprobe for your platform into `resources/ffmpeg/`.

```bash
npm install
npm start            # dev mode with Vite HMR for the renderer
npm run typecheck
npm test             # unit + integration tests (uses the bundled FFmpeg)
npm run package      # production build into out/ (also builds .vite/ used by e2e)
npm run test:e2e     # Playwright end-to-end tests against the production build
```

> **VS Code terminals** export `ELECTRON_RUN_AS_NODE=1`, which makes Electron start as plain Node (`bad option: --remote-debugging-port`). Run `npm start` from a regular terminal, or unset the variable first. The e2e tests strip it automatically.

If `node_modules/electron/dist` is missing after install, run `node node_modules/electron/install.js`.

The e2e suite uses Chromium's synthetic camera and microphone (`BLOOM_FAKE_MEDIA=1`) and an isolated data directory (`BLOOM_USER_DATA`). It records your real screen for a few seconds, then deletes the files it created.

### Database migrations

The schema lives in `electron/storage/schema.ts`. After changing it, run `npm run db:generate` and register the new SQL file in `electron/storage/migrations/index.ts`. Migrations are bundled into the app and applied transactionally at startup.

## Building releases

Builds are per platform and per architecture: run them on the target OS, or on CI runners for each OS.

| Target | Command | Artifacts |
| --- | --- | --- |
| Windows x64 / arm64 | `npm run make` | Squirrel installer (`out/make/squirrel.windows/…/BloomRecord Setup.exe`) + ZIP |
| macOS x64 / arm64 | `npm run make` | DMG + ZIP |
| Linux x64 / arm64 | `npm run make` | `.deb`, `.rpm`, ZIP |

**FFmpeg binaries per target.** `scripts/prepare-ffmpeg.mjs` copies the FFmpeg/FFprobe for `BLOOM_TARGET_PLATFORM` / `BLOOM_TARGET_ARCH` (default: the host) into `resources/ffmpeg/`. The Forge `prePackage` hook refuses to package mismatched binaries.

To build for another architecture on the same OS, first fetch that architecture's FFmpeg:

```bash
npm_config_arch=arm64 npm rebuild ffmpeg-static
BLOOM_TARGET_ARCH=arm64 node scripts/prepare-ffmpeg.mjs
```

Then run `npx electron-forge make --arch=arm64`.

**Signing.** Unsigned builds work but trigger OS warnings.
- **macOS:** add `osxSign` and `osxNotarize` to `packagerConfig` in `forge.config.mts`. The hardened runtime needs the camera and microphone entitlements. The usage strings are already in `extendInfo`.
- **Windows:** pass `certificateFile` / `certificatePassword` (or a signing hook) to `MakerSquirrel`.

**Security fuses.** Packaged apps have `RunAsNode`, `NODE_OPTIONS` and the `--inspect` flags disabled. They also enforce asar integrity and only load the app from the asar.

### FFmpeg licensing

The bundled binaries come from `ffmpeg-static` / `ffprobe-static`. They are **GPL** builds that include libx264. Distributing BloomRecord with them means meeting the GPL's terms, including offering the corresponding FFmpeg source.

If that isn't acceptable, ship an LGPL FFmpeg build instead. You would then need to swap `libx264` in `electron/media/compose.ts` and `trim.ts` for a platform encoder such as `h264_mf` (Windows), `h264_videotoolbox` (macOS) or `h264_vaapi` (Linux).

## Platform support and limitations

| Platform | Status |
| --- | --- |
| Windows 11 x64 | **Built and tested.** Unit, integration and e2e suites pass, the e2e suite records real screen captures, and the packaged app launches. |
| macOS | Implemented, **not yet tested** on hardware. |
| Linux (X11 / Wayland) | Implemented, **not yet tested**. |

Platform notes:

- **Windows:** system audio uses WASAPI loopback of the default output device. Camera and microphone access follow *Settings → Privacy & security*; the app links there when access is denied.
- **macOS:** Screen Recording permission must be granted in System Settings, then the app restarted (Apple doesn't allow a programmatic prompt). Camera and microphone are requested through the system prompts. **Direct system-audio capture is not enabled.** As a fallback, install a loopback driver such as BlackHole and select it as the microphone.
- **Linux:** on Wayland, the desktop portal (xdg-desktop-portal + PipeWire) shows its own picker when recording starts, so the in-app source list is replaced by a notice. **System audio isn't captured directly.** Choose a PulseAudio/PipeWire "Monitor of …" input as the microphone instead.
- **Window capture:** if a captured window is resized, the output is letterboxed to the first frame size (no stretching). If the window closes, the recording stops automatically.
- **Unplugged devices:** if the camera or microphone is unplugged mid-recording, recording continues and that track ends early (the bubble disappears, or audio falls silent).
- **Fast-copy trimming:** cuts snap to the nearest keyframe (the encoder emits one every 2 s). Use frame-accurate mode for exact cuts.

## Security model

- The renderer runs with `contextIsolation`, `sandbox` and no `nodeIntegration`. It sees only `window.bloom`, a narrow, typed API over fixed IPC channels.
- Every IPC request is checked for a trusted sender (our own top-level frame), validated with strict Zod schemas, and answered with a `{ ok, data | error }` envelope. Internal error details stay in the main process.
- Production UI is served from a custom `app://` protocol with a strict CSP (`default-src 'none'`, no remote origins, no `unsafe-eval`). Navigation, new windows and webviews are blocked.
- The renderer never supplies file paths.
  - Media is streamed by recording ID through `bloom-media://`, which supports range requests.
  - Output folders and export destinations come only from native dialogs shown by main.
  - Filenames are sanitised for Windows, macOS and Linux.
- FFmpeg is spawned with argument arrays (`shell: false`), absolute bundled binary paths, and an `AbortSignal`, so cancelling kills the process.
- Only camera, microphone and screen permissions are granted, and only to the app's own origin.
