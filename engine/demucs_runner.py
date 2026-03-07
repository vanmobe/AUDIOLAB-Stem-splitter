from __future__ import annotations

from pathlib import Path
import shutil
import subprocess
import sys
import importlib.util
import numpy as np
from typing import Callable

from io_audio import read_audio, write_audio, peak_limit

TARGET_SR = 44100
STEM_NAMES_4 = ["vocals", "drums", "bass", "other"]
FALLBACK_MODELS = [
    "htdemucs",
    "htdemucs_ft",
    "mdx",
    "mdx_extra",
]
DEMUX_MLX_MDX_MODELS = {"mdx", "mdx_extra", "mdx_q", "mdx_extra_q"}


def _resample_linear(audio: np.ndarray, src_sr: int, dst_sr: int) -> np.ndarray:
    if src_sr == dst_sr:
        return audio
    if audio.size == 0:
        return audio
    src_len = audio.shape[0]
    dst_len = max(1, int(round(src_len * float(dst_sr) / float(src_sr))))
    x_src = np.linspace(0.0, 1.0, src_len, endpoint=False)
    x_dst = np.linspace(0.0, 1.0, dst_len, endpoint=False)
    out = np.empty((dst_len, audio.shape[1]), dtype=np.float32)
    for c in range(audio.shape[1]):
        out[:, c] = np.interp(x_dst, x_src, audio[:, c]).astype(np.float32)
    return out


def _prepare_input_audio(input_path: Path, output_root: Path) -> Path:
    """
    Normalize and resample input to avoid common model failures and clipping artifacts.
    """
    audio, sr = read_audio(input_path)
    audio = audio - np.mean(audio, axis=0, keepdims=True)  # remove DC offset
    audio = peak_limit(audio, peak=0.92)  # keep headroom for model input

    if sr != TARGET_SR:
        audio = _resample_linear(audio, sr, TARGET_SR)
        sr = TARGET_SR

    staged = output_root / "_prepared_input_44k.wav"
    write_audio(staged, audio, sr)
    return staged


def _module_exists(name: str) -> bool:
    return importlib.util.find_spec(name) is not None


def resolve_demucs_backend() -> tuple[str, list[str], str]:
    """
    Returns (backend_name, base_command, model_flag).
    backend_name is one of: demucs-mlx, demucs.
    """
    demucs_mlx_cmd = shutil.which("demucs-mlx")
    if demucs_mlx_cmd:
        return ("demucs-mlx", [demucs_mlx_cmd], "-n")
    if _module_exists("demucs_mlx"):
        return ("demucs-mlx", [sys.executable, "-m", "demucs_mlx"], "-n")

    demucs_cmd = shutil.which("demucs")
    if demucs_cmd:
        return ("demucs", [demucs_cmd], "-n")
    if _module_exists("demucs.separate"):
        return ("demucs", [sys.executable, "-m", "demucs.separate"], "-n")

    raise RuntimeError(
        "No Demucs backend found. Install demucs-mlx (macOS/Apple Silicon) "
        "or demucs (Windows/Linux)."
    )


def demucs_list_models_cmd() -> list[str]:
    backend_name, base_cmd, _ = resolve_demucs_backend()
    if backend_name == "demucs":
        return base_cmd + ["--list-models"]
    # demucs-mlx variants are not consistent in list-models support.
    # Let callers use fallback model hints when listing is unavailable.
    return []


def fallback_models_for_backend(backend_name: str | None) -> list[str]:
    if backend_name in {"demucs", "demucs-mlx"}:
        return FALLBACK_MODELS.copy()
    return []


def _demucs_mlx_supports_mdx_models() -> bool:
    """
    Newer MLX builds removed `mlx.core.angle`, which currently breaks MDX model
    variants in demucs-mlx. Guard these models when unsupported.
    """
    try:
        import mlx.core as mx

        return hasattr(mx, "angle")
    except Exception:
        return False


def incompatible_models_for_backend(backend_name: str | None) -> set[str]:
    if backend_name == "demucs-mlx" and not _demucs_mlx_supports_mdx_models():
        return DEMUX_MLX_MDX_MODELS.copy()
    return set()


def filter_compatible_models(models: list[str], backend_name: str | None) -> list[str]:
    blocked = incompatible_models_for_backend(backend_name)
    if not blocked:
        return models
    return [m for m in models if m not in blocked]


def _quality_params(quality_mode: str) -> tuple[float, int, int]:
    if quality_mode == "fast":
        return (0.15, 1, 6)
    if quality_mode == "high":
        return (0.35, 4, 7)
    return (0.25, 2, 7)  # balanced


def _run_single_demucs(
    input_path: Path,
    output_root: Path,
    quality_mode: str,
    model: str | None,
) -> Path:
    backend_name, base_cmd, model_flag = resolve_demucs_backend()
    overlap, shifts, segment = _quality_params(quality_mode)
    cmd = base_cmd + [
        "-o",
        str(output_root),
        "--overlap",
        str(overlap),
        "--shifts",
        str(shifts),
        "--segment",
        str(segment),
    ]
    if model:
        cmd += [model_flag, model]
    cmd += [str(input_path)]

    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    timeout_sec = 60 * 30
    try:
        stdout, stderr = proc.communicate(timeout=timeout_sec)
    except subprocess.TimeoutExpired:
        proc.kill()
        stdout, stderr = proc.communicate()
        raise RuntimeError(
            f"Separation timed out after {timeout_sec // 60} minutes. "
            f"Try quality_mode='balanced' or shorter audio.\n"
            + (stdout or "")[-500:]
            + "\n"
            + (stderr or "")[-800:]
        )

    if proc.returncode != 0:
        raise RuntimeError(
            f"{backend_name} failed.\n" + (stdout or "")[-500:] + "\n" + (stderr or "")[-800:]
        )

    candidates = []
    for p in output_root.rglob("vocals.wav"):
        folder = p.parent
        if all((folder / f"{name}.wav").exists() for name in STEM_NAMES_4):
            candidates.append(folder)
    if not candidates:
        raise RuntimeError("Could not locate stems folder in demucs output.")
    candidates.sort(key=lambda x: x.stat().st_mtime, reverse=True)
    return candidates[0]


def _average_stem_sets(a_folder: Path, b_folder: Path, out_folder: Path) -> Path:
    out_folder.mkdir(parents=True, exist_ok=True)
    for name in STEM_NAMES_4:
        a, sr_a = read_audio(a_folder / f"{name}.wav")
        b, sr_b = read_audio(b_folder / f"{name}.wav")
        if sr_a != sr_b:
            b = _resample_linear(b, sr_b, sr_a)
        t = min(a.shape[0], b.shape[0])
        c = min(a.shape[1], b.shape[1])
        blended = (0.5 * a[:t, :c] + 0.5 * b[:t, :c]).astype(np.float32)
        write_audio(out_folder / f"{name}.wav", blended, sr_a)
    return out_folder


def _render_true_two_stem(stems4_folder: Path, out_folder: Path) -> Path:
    out_folder.mkdir(parents=True, exist_ok=True)
    vocals, sr = read_audio(stems4_folder / "vocals.wav")
    drums, _ = read_audio(stems4_folder / "drums.wav")
    bass, _ = read_audio(stems4_folder / "bass.wav")
    other, _ = read_audio(stems4_folder / "other.wav")

    t = min(vocals.shape[0], drums.shape[0], bass.shape[0], other.shape[0])
    c = min(vocals.shape[1], drums.shape[1], bass.shape[1], other.shape[1])
    vocals = vocals[:t, :c]
    instrumental = (drums[:t, :c] + bass[:t, :c] + other[:t, :c]).astype(np.float32)
    instrumental = peak_limit(instrumental, peak=0.999)

    write_audio(out_folder / "vocals.wav", vocals, sr)
    write_audio(out_folder / "instrumental.wav", instrumental, sr)
    return out_folder


def run_demucs_mlx(
    input_path: Path,
    output_root: Path,
    stems: int = 4,
    quality_mode: str = "balanced",
    model: str | None = None,
    ensemble_model: str | None = None,
    progress_cb: Callable[[float, str], None] | None = None,
) -> Path:
    """
    Runs demucs-mlx with quality controls and optional 2-model ensemble.
    Returns a folder containing output stems.
    """
    output_root.mkdir(parents=True, exist_ok=True)
    backend_name, _, _ = resolve_demucs_backend()
    blocked = incompatible_models_for_backend(backend_name)
    if model and model in blocked:
        raise RuntimeError(
            f"Model '{model}' is currently incompatible with backend {backend_name} on this system. "
            "Use htdemucs/htdemucs_ft (or update MLX/demucs-mlx)."
        )
    if ensemble_model and ensemble_model in blocked:
        raise RuntimeError(
            f"Ensemble model '{ensemble_model}' is currently incompatible with backend {backend_name} on this system. "
            "Use htdemucs/htdemucs_ft (or update MLX/demucs-mlx)."
        )
    if progress_cb:
        progress_cb(0.12, "Preparing input audio…")
    prepared_input = _prepare_input_audio(input_path, output_root)

    run_a = output_root / "run_a"
    if progress_cb:
        if model:
            progress_cb(0.22, f"Running model 1/2: {model}")
        else:
            progress_cb(0.22, "Running model 1/2")
    stems_a = _run_single_demucs(prepared_input, run_a, quality_mode, model)
    stems_folder = stems_a

    if ensemble_model and ensemble_model != model:
        run_b = output_root / "run_b"
        if progress_cb:
            progress_cb(0.50, f"Running model 2/2: {ensemble_model}")
        stems_b = _run_single_demucs(prepared_input, run_b, quality_mode, ensemble_model)
        if progress_cb:
            progress_cb(0.70, "Ensemble merge…")
        stems_folder = _average_stem_sets(stems_a, stems_b, output_root / "ensemble_stems")
    else:
        if progress_cb:
            progress_cb(0.70, "Separation complete. Finalizing…")

    if stems == 2:
        if progress_cb:
            progress_cb(0.78, "Rendering true 2-stem output…")
        return _render_true_two_stem(stems_folder, output_root / "stems_2")
    if progress_cb:
        progress_cb(0.82, "Preparing 4 stems output…")
    return stems_folder


def copy_stems(stems_folder: Path, out_folder: Path) -> None:
    out_folder.mkdir(parents=True, exist_ok=True)
    for src in stems_folder.glob("*.wav"):
        shutil.copy2(src, out_folder / src.name)
