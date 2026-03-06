# AudioLab Splitter Desktop (Tauri)

Cross-platform desktop shell (macOS + Windows target) for the local splitter engine.

## Features
- Select engine folder (`engine/`)
- Start/stop the engine from the desktop app
- Select input audio file and output folder
- Choose stems (`2` or `4`) and preset (`fast`, `best`, `vocal_boost`)
- Choose quality mode (`fast`, `balanced`, `high`)
- Choose Demucs model and optional ensemble model
- Track job progress and status
- Preview and combine stems in the Player tab
- Run environment self-check diagnostics (Python/Demucs/ffmpeg/models)

## Prerequisites
- Node.js 20+
- Rust toolchain (required by Tauri for desktop builds)
- Python engine set up in `../engine/.venv`
- `cargo` available in PATH (`cargo --version` should work)

## Setup
```bash
cd desktop-app
npm install
```

## Run (desktop app)
```bash
npm run tauri dev
```

## Frontend build only
```bash
npm run build
```

## CI / Installer Builds
- `../.github/workflows/ci.yml`: builds frontend on PRs and pushes to `main`
- `../.github/workflows/build-installers.yml`:
  - `workflow_dispatch`: manual macOS + Windows installer build
  - `push tags v*`: builds and publishes release assets
  - Run artifacts: downloadable in GitHub Actions under `splitlab-macos-latest` / `splitlab-windows-latest`
  - Release assets: `https://github.com/vanmobe/AUDIOLAB.sound.splitter/releases`

## Screenshot Placeholder
Store screenshots in `../docs/images/`.

Example reference:
```md
![SPLITLAB UI](../docs/images/screenshot-main.png)
```
