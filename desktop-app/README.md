# AudioLab Splitter Desktop (Tauri)

Cross-platform desktop shell (macOS + Windows target) for the local splitter engine.

## Features
- Auto-start engine (no folder selection needed for normal installer usage)
- Optional advanced engine folder override
- Start/stop the engine from the desktop app
- Select input audio file and output folder
- Choose stems (`2` or `4`) and preset (`fast`, `best`, `vocal_boost`)
- Choose quality mode (`fast`, `balanced`, `high`)
- Choose Demucs model and optional ensemble model
- Track job progress and status
- Preview and combine stems in the Player tab
- Run environment self-check diagnostics (Python/Demucs/ffmpeg/models)

## Installer behavior
- Engine files are bundled into the app package.
- CI builds include a prebuilt engine `.venv` in the installer resources (per OS).
- On first launch, SplitLAB copies bundled engine resources to app data and starts the engine.
- Normal user install/start does not require internet access.

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
  - Run artifacts: downloadable in GitHub Actions under `splitlab-macos` / `splitlab-windows`
  - Release assets: `https://github.com/vanmobe/AUDIOLAB.sound.splitter/releases`
  - Release notes include direct links to each generated installer file

## Screenshot Placeholder
Store screenshots in `../docs/images/`.

Example reference:
```md
![SPLITLAB UI](../docs/images/screenshot-main.png)
```

## macOS Notice: Unsigned Hobby Build
This desktop app is a hobby project release. It is not code-signed and not notarized on macOS because there is no paid Apple Developer membership configured for this project.

If macOS blocks startup with a damaged-app message, run this workaround:

```bash
xattr -dr com.apple.quarantine "/Applications/SplitLAB.app"
```

Then launch the app again (or right-click and choose `Open` once).

This warning is expected for unsigned apps and does not indicate a broken stem separation engine.
