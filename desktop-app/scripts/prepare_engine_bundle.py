#!/usr/bin/env python3
from __future__ import annotations

import argparse
import os
import shutil
from pathlib import Path


ENGINE_FILES = [
    "server.py",
    "jobs.py",
    "demucs_runner.py",
    "io_audio.py",
    "postprocess.py",
    "requirements.txt",
]


def main() -> int:
    parser = argparse.ArgumentParser(description="Prepare bundled engine payload for installers.")
    parser.add_argument("--engine-dir", required=True, help="Path to engine source folder.")
    parser.add_argument("--bundle-dir", required=True, help="Path to output engine bundle folder.")
    parser.add_argument("--bundle-id", default="dev", help="Bundle version identifier.")
    args = parser.parse_args()

    engine_dir = Path(args.engine_dir).resolve()
    bundle_dir = Path(args.bundle_dir).resolve()

    if not engine_dir.is_dir():
        raise SystemExit(f"Engine dir not found: {engine_dir}")

    if bundle_dir.exists():
        shutil.rmtree(bundle_dir)
    bundle_dir.mkdir(parents=True, exist_ok=True)

    for name in ENGINE_FILES:
        src = engine_dir / name
        if not src.exists():
            raise SystemExit(f"Missing engine file: {src}")
        shutil.copy2(src, bundle_dir / name)

    # Copy prebuilt venv if present (preferred for offline installers).
    src_venv = engine_dir / ".venv"
    if src_venv.is_dir():
        shutil.copytree(src_venv, bundle_dir / ".venv")

    (bundle_dir / ".splitlab_bundle_id").write_text(str(args.bundle_id), encoding="utf-8")
    (bundle_dir / ".splitlab_bundle_ready").write_text("ok", encoding="utf-8")
    print(f"Engine bundle prepared at: {bundle_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
