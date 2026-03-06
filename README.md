# SPLITLAB

Local stem splitter with:
- Python engine (`engine/`)
- Cross-platform Tauri desktop app (`desktop-app/`) for macOS and Windows

## Functionality
SplitLAB is a local AI stem separation tool that runs on your own machine.

- Separates tracks into `2` stems (`vocals`, `instrumental`) or `4` stems (`vocals`, `drums`, `bass`, `other`)
- Supports model selection and optional 2-model ensemble for higher quality output
- Includes quality modes (`fast`, `balanced`, `high`) and presets (`fast`, `best`, `vocal_boost`)
- Provides a built-in player to audition stems, control levels, and preview combinations
- Keeps processing local (no cloud upload required)

## What’s included
- `engine/`: local FastAPI engine that runs Demucs backend (`demucs-mlx` on macOS or `demucs` on Windows/Linux), then post-processing (residual correction, peak limiting)
- `desktop-app/`: Tauri desktop client (TypeScript + Rust) for cross-platform use

## Dev prerequisites
- macOS or Windows
- Python 3.10+ (for the local engine)
- Node.js 20+
- Rust (for Tauri desktop builds)

## Engine setup
```bash
cd engine
python -m venv .venv
# macOS/Linux: source .venv/bin/activate
# Windows (PowerShell): .venv\Scripts\Activate.ps1
pip install -r requirements.txt
```

## Run in dev
In this Phase 2 setup the app auto-starts the engine by running:
`<venv-python> -m uvicorn server:app --host 127.0.0.1 --port 8732`
from the `engine/` directory.

## Cross-platform desktop GUI (Tauri)
Use the Tauri app in `desktop-app/` for macOS + Windows.

```bash
cd desktop-app
npm install
npm run tauri dev
```

The Tauri app supports:
- browsing for engine folder, input audio file, and output destination
- starting/stopping engine process
- running split jobs and polling progress
- opening output folder directly
- loading and auditioning stems in sync

## Installers (macOS + Windows)
This repo includes GitHub Actions workflows that produce downloadable desktop installers.

- Manual build: run the `Build Installers` workflow in GitHub Actions
- Release build: push a version tag (for example `v0.1.0`) to build and publish assets to GitHub Releases
- Workflow artifacts: downloadable from the run page under `Artifacts` (`splitlab-macos-latest`, `splitlab-windows-latest`)
- Release assets: downloadable from `https://github.com/vanmobe/AUDIOLAB.sound.splitter/releases`

Workflow files:
- `.github/workflows/build-installers.yml`
- `.github/workflows/ci.yml`

## App Screenshot
Add screenshots in `docs/images/` and reference them here.

Example:
```md
![SPLITLAB Main UI](docs/images/screenshot-main.png)
```

## Open in VS Code
Open this repo root in VS Code.
