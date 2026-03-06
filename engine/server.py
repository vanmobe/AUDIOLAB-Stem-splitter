from __future__ import annotations
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from pathlib import Path
import threading
import subprocess
import shutil
import sys

from jobs import STORE, run_job, external_demucs_running, external_demucs_processes
from demucs_runner import (
    demucs_list_models_cmd,
    fallback_models_for_backend,
    resolve_demucs_backend,
)

app = FastAPI(title="Moises Local Engine", version="0.2.0")

# Allow local desktop/web clients (Tauri/WebView/etc.) to call the engine API.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

class SeparateRequest(BaseModel):
    input_path: str
    output_dir: str
    stems: int = 4                # 2 or 4
    preset: str = "best"          # fast | best | vocal_boost
    quality_mode: str = "balanced"  # fast | balanced | high
    model: str | None = None
    ensemble_model: str | None = None

class JobResponse(BaseModel):
    id: str
    status: str
    progress: float
    message: str
    output_dir: str
    stems_dir: str
    preset: str
    error: str | None = None

class ModelsResponse(BaseModel):
    models: list[str]

class EngineStateResponse(BaseModel):
    tracked_active_job_id: str | None
    external_demucs_processes: list[dict[str, str]]

class CheckItem(BaseModel):
    key: str
    status: str  # pass | warn | fail
    message: str

class SelfCheckResponse(BaseModel):
    ok: bool
    checks: list[CheckItem]
    python_executable: str
    python_version: str
    demucs_backend: str | None = None
    demucs_command: list[str] = []
    ffmpeg_path: str | None = None
    models_count: int = 0
    models: list[str] = []

@app.get("/health")
def health():
    return {"ok": True}

def _parse_models_output(lines: list[str]) -> list[str]:
    parsed: list[str] = []
    for raw in lines:
        line = raw.strip()
        if not line:
            continue
        if line.lower().startswith("available models"):
            continue
        # Common output forms:
        # "model_name<TAB>description"
        # "model_name description"
        # "model_name: description"
        token = line.split(":", 1)[0].strip()
        if "\t" in token:
            token = token.split("\t", 1)[0].strip()
        if " " in token:
            token = token.split(" ", 1)[0].strip()
        if token and token not in parsed:
            parsed.append(token)
    return parsed

@app.get("/models", response_model=ModelsResponse)
def models():
    try:
        backend_name, _, _ = resolve_demucs_backend()
        cmd = demucs_list_models_cmd()
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"No Demucs backend available: {e}")

    fallback = fallback_models_for_backend(backend_name)
    if not cmd:
        return ModelsResponse(models=fallback)

    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=20, check=False)
    except Exception as e:
        if fallback:
            return ModelsResponse(models=fallback)
        raise HTTPException(status_code=500, detail=f"Failed to list models: {e}")

    if proc.returncode != 0:
        detail = ((proc.stdout or "") + "\n" + (proc.stderr or "")).strip()
        if fallback:
            return ModelsResponse(models=fallback)
        raise HTTPException(status_code=500, detail=f"Model listing failed: {detail[-500:]}")

    parsed = _parse_models_output((proc.stdout or "").splitlines())
    if not parsed:
        if fallback:
            return ModelsResponse(models=fallback)
        raise HTTPException(status_code=500, detail=f"Model listing returned no models from backend {backend_name}.")
    return ModelsResponse(models=parsed)

@app.get("/self-check", response_model=SelfCheckResponse)
def self_check():
    checks: list[CheckItem] = []
    backend_name: str | None = None
    demucs_cmd: list[str] = []
    models: list[str] = []
    ffmpeg_path = shutil.which("ffmpeg")

    checks.append(
        CheckItem(
            key="python",
            status="pass",
            message=f"Python {sys.version.split()[0]} at {sys.executable}",
        )
    )

    try:
        backend_name, _, _ = resolve_demucs_backend()
        demucs_cmd = demucs_list_models_cmd()
        checks.append(
            CheckItem(
                key="demucs_backend",
                status="pass",
                message=f"Detected backend: {backend_name}",
            )
        )
    except Exception as e:
        checks.append(
            CheckItem(
                key="demucs_backend",
                status="fail",
                message=f"Demucs backend missing: {e}",
            )
        )

    if ffmpeg_path:
        checks.append(
            CheckItem(
                key="ffmpeg",
                status="pass",
                message=f"ffmpeg found at {ffmpeg_path}",
            )
        )
    else:
        checks.append(
            CheckItem(
                key="ffmpeg",
                status="warn",
                message="ffmpeg not found in PATH. Some input formats may fail or convert slower.",
            )
        )

    if demucs_cmd:
        try:
            proc = subprocess.run(
                demucs_cmd,
                capture_output=True,
                text=True,
                timeout=20,
                check=False,
            )
            if proc.returncode == 0:
                models = _parse_models_output((proc.stdout or "").splitlines())
                if models:
                    checks.append(
                        CheckItem(
                            key="models",
                            status="pass",
                            message=f"{len(models)} model(s) available.",
                        )
                    )
                else:
                    checks.append(
                        CheckItem(
                            key="models",
                            status="warn",
                            message="Model command worked but returned no parsed models.",
                        )
                    )
            else:
                detail = ((proc.stdout or "") + "\n" + (proc.stderr or "")).strip()
                checks.append(
                    CheckItem(
                        key="models",
                        status="fail",
                        message=f"Model listing failed: {detail[-300:]}",
                    )
                )
        except Exception as e:
            checks.append(
                CheckItem(
                    key="models",
                    status="fail",
                    message=f"Model listing error: {e}",
                )
            )
    elif backend_name:
        models = fallback_models_for_backend(backend_name)
        if models:
            checks.append(
                CheckItem(
                    key="models",
                    status="warn",
                    message=f"Using fallback model list for backend {backend_name}.",
                )
            )

    ok = not any(c.status == "fail" for c in checks)
    return SelfCheckResponse(
        ok=ok,
        checks=checks,
        python_executable=sys.executable,
        python_version=sys.version.split()[0],
        demucs_backend=backend_name,
        demucs_command=demucs_cmd,
        ffmpeg_path=ffmpeg_path,
        models_count=len(models),
        models=models,
    )

@app.post("/separate", response_model=JobResponse)
def separate(req: SeparateRequest):
    inp = Path(req.input_path).expanduser().resolve()
    out = Path(req.output_dir).expanduser().resolve()

    if not inp.exists():
        raise HTTPException(status_code=400, detail="input_path does not exist")

    if req.preset not in ["fast", "best", "vocal_boost"]:
        raise HTTPException(status_code=400, detail="invalid preset")

    if req.quality_mode not in ["fast", "balanced", "high"]:
        raise HTTPException(status_code=400, detail="invalid quality_mode")

    if req.stems not in [2, 4]:
        raise HTTPException(status_code=400, detail="invalid stems")

    if STORE.has_active() or external_demucs_running():
        external = external_demucs_processes()
        if external:
            detail = (
                "engine busy: external demucs process still running "
                f"(pid={external[0].get('pid','?')}, etime={external[0].get('etime','?')}). "
                "Wait for it to finish or terminate it."
            )
        else:
            detail = "engine busy: another split is still running"
        raise HTTPException(status_code=409, detail=detail)

    out.mkdir(parents=True, exist_ok=True)
    job = STORE.create(
        inp,
        out,
        stems=req.stems,
        preset=req.preset,
        quality_mode=req.quality_mode,
        model=req.model,
        ensemble_model=req.ensemble_model,
    )

    t = threading.Thread(target=run_job, args=(job,), daemon=True)
    t.start()

    stems_dir = out / "stems"
    return JobResponse(
        id=job.id,
        status=job.status,
        progress=job.progress,
        message=job.message,
        output_dir=str(job.output_dir),
        stems_dir=str(stems_dir),
        preset=job.preset,
        error=job.error
    )

@app.get("/jobs/{job_id}", response_model=JobResponse)
def get_job(job_id: str):
    job = STORE.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="job not found")
    stems_dir = job.output_dir / "stems"
    return JobResponse(
        id=job.id,
        status=job.status,
        progress=job.progress,
        message=job.message,
        output_dir=str(job.output_dir),
        stems_dir=str(stems_dir),
        preset=job.preset,
        error=job.error
    )

@app.get("/active-job", response_model=JobResponse)
def get_active_job():
    job = STORE.get_active()
    if not job:
        external = external_demucs_processes()
        if external:
            d = external[0]
            raise HTTPException(
                status_code=409,
                detail=(
                    "no tracked active job, but external demucs process is running "
                    f"(pid={d.get('pid','?')}, etime={d.get('etime','?')}). "
                    "This usually means a stale/orphan process from a previous session."
                ),
            )
        raise HTTPException(status_code=404, detail="no active job")
    stems_dir = job.output_dir / "stems"
    return JobResponse(
        id=job.id,
        status=job.status,
        progress=job.progress,
        message=job.message,
        output_dir=str(job.output_dir),
        stems_dir=str(stems_dir),
        preset=job.preset,
        error=job.error
    )

@app.get("/engine-state", response_model=EngineStateResponse)
def engine_state():
    active = STORE.get_active()
    return EngineStateResponse(
        tracked_active_job_id=active.id if active else None,
        external_demucs_processes=external_demucs_processes(),
    )
