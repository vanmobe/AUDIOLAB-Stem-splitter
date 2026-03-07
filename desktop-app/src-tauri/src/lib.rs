use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::thread;
use std::time::Duration;
use std::{env, fs::OpenOptions};
use std::fs;

static ENGINE_CHILD: OnceLock<Mutex<Option<Child>>> = OnceLock::new();

fn engine_slot() -> &'static Mutex<Option<Child>> {
    ENGINE_CHILD.get_or_init(|| Mutex::new(None))
}

fn resolve_engine_dir(input: &Path) -> Option<PathBuf> {
    if input.join("server.py").exists() {
        return Some(input.to_path_buf());
    }
    let nested = input.join("engine");
    if nested.join("server.py").exists() {
        return Some(nested);
    }
    let bundle = input.join("engine_bundle");
    if bundle.join("server.py").exists() {
        return Some(bundle);
    }
    None
}

fn find_engine_dir(root: &Path) -> Option<PathBuf> {
    if let Some(found) = resolve_engine_dir(root) {
        return Some(found);
    }
    if !root.exists() || !root.is_dir() {
        return None;
    }

    // Installer layouts can vary between platforms and toolchain versions.
    // Recursively search a few levels for a folder that contains server.py.
    let max_depth = 4usize;
    let mut q: VecDeque<(PathBuf, usize)> = VecDeque::new();
    q.push_back((root.to_path_buf(), 0));

    while let Some((dir, depth)) = q.pop_front() {
        if let Some(found) = resolve_engine_dir(&dir) {
            return Some(found);
        }
        if depth >= max_depth {
            continue;
        }
        let rd = match fs::read_dir(&dir) {
            Ok(v) => v,
            Err(_) => continue,
        };
        for e in rd.flatten() {
            let p = e.path();
            if p.is_dir() {
                q.push_back((p, depth + 1));
            }
        }
    }

    None
}

#[tauri::command]
fn engine_location_hint(engine_dir: Option<String>) -> Result<String, String> {
    let mut search_roots: Vec<PathBuf> = Vec::new();
    if let Some(raw) = engine_dir {
        let trimmed = raw.trim();
        if !trimmed.is_empty() {
            search_roots.push(PathBuf::from(trimmed));
        }
    }
    search_roots.extend(default_engine_search_roots());

    let resolved = search_roots.iter().find_map(|root| find_engine_dir(root));
    let managed = splitlab_data_root().join("engine-managed").join("engine");
    let log_path = env::temp_dir().join("audiolab-splitter-engine.log");

    let mut lines: Vec<String> = Vec::new();
    if let Some(src) = resolved {
        if should_materialize_engine(&src) {
            lines.push(format!("Bundled engine source: {}", src.display()));
            lines.push(format!("Managed engine location: {}", managed.display()));
        } else {
            lines.push(format!("Engine location: {}", src.display()));
        }
    } else {
        lines.push("Engine location: not detected yet (will resolve when engine starts).".to_string());
        lines.push(format!("Expected managed engine location: {}", managed.display()));
    }
    lines.push(format!("Engine log file: {}", log_path.display()));
    Ok(lines.join("\n"))
}

fn default_engine_search_roots() -> Vec<PathBuf> {
    let mut roots: Vec<PathBuf> = Vec::new();
    if let Ok(v) = env::var("SPLITLAB_ENGINE_DIR") {
        let p = PathBuf::from(v);
        if !p.as_os_str().is_empty() {
            roots.push(p);
        }
    }
    if let Ok(cwd) = env::current_dir() {
        roots.push(cwd.clone());
        roots.push(cwd.join("engine"));
    }
    if let Ok(exe) = env::current_exe() {
        if let Some(exe_dir) = exe.parent() {
            roots.push(exe_dir.to_path_buf());
            roots.push(exe_dir.join("engine"));
            roots.push(exe_dir.join("../engine"));
            roots.push(exe_dir.join("../resources/engine"));
            roots.push(exe_dir.join("../Resources/engine"));
            roots.push(exe_dir.join("../resources/engine_bundle"));
            roots.push(exe_dir.join("../Resources/engine_bundle"));
            roots.push(exe_dir.join("../../Resources/engine"));
            roots.push(exe_dir.join("../../Resources/engine_bundle"));
        }
    }
    roots
}

#[derive(Clone, Debug)]
struct PythonLaunch {
    program: String,
    pre_args: Vec<String>,
}

fn splitlab_data_root() -> PathBuf {
    #[cfg(windows)]
    {
        if let Ok(v) = env::var("LOCALAPPDATA") {
            return PathBuf::from(v).join("SplitLAB");
        }
        if let Ok(v) = env::var("APPDATA") {
            return PathBuf::from(v).join("SplitLAB");
        }
    }
    #[cfg(not(windows))]
    {
        if let Ok(v) = env::var("HOME") {
            return PathBuf::from(v)
                .join("Library")
                .join("Application Support")
                .join("SplitLAB");
        }
    }
    env::temp_dir().join("SplitLAB")
}

fn should_materialize_engine(path: &Path) -> bool {
    let s = path.to_string_lossy().to_lowercase();
    s.contains("/resources/") || s.contains("\\resources\\")
}

fn copy_dir_recursive(src: &Path, dst: &Path) -> Result<(), String> {
    fs::create_dir_all(dst)
        .map_err(|e| format!("Failed to create folder {}: {e}", dst.display()))?;
    let rd = fs::read_dir(src)
        .map_err(|e| format!("Failed to read folder {}: {e}", src.display()))?;
    for e in rd {
        let e = e.map_err(|err| format!("Failed to read entry in {}: {err}", src.display()))?;
        let p = e.path();
        let name = e.file_name();
        let name_s = name.to_string_lossy();
        if name_s == "__pycache__" {
            continue;
        }
        let out = dst.join(&name);
        if p.is_dir() {
            copy_dir_recursive(&p, &out)?;
        } else {
            fs::copy(&p, &out).map_err(|err| {
                format!("Failed to copy {} to {}: {err}", p.display(), out.display())
            })?;
        }
    }
    Ok(())
}

fn bundle_id(path: &Path) -> String {
    fs::read_to_string(path.join(".splitlab_bundle_id"))
        .map(|s| s.trim().to_string())
        .unwrap_or_else(|_| "dev".to_string())
}

fn materialize_engine_dir(source: &Path) -> Result<PathBuf, String> {
    let managed_root = splitlab_data_root().join("engine-managed");
    let target = managed_root.join("engine");
    fs::create_dir_all(&managed_root).map_err(|e| {
        format!(
            "Failed to create managed engine root {}: {e}",
            managed_root.display()
        )
    })?;
    let source_id = bundle_id(source);
    let target_id_path = target.join(".splitlab_bundle_id");
    let target_id = fs::read_to_string(&target_id_path)
        .map(|s| s.trim().to_string())
        .unwrap_or_default();

    let needs_sync = !target.join("server.py").exists() || target_id != source_id;
    if needs_sync {
        if target.exists() {
            let _ = fs::remove_dir_all(&target);
        }
        copy_dir_recursive(source, &target)?;
        fs::write(&target_id_path, source_id)
            .map_err(|e| format!("Failed writing {}: {e}", target_id_path.display()))?;
    }
    Ok(target)
}

fn command_available(program: &str) -> bool {
    let path = PathBuf::from(program);
    if path.is_absolute() {
        return path.exists();
    }
    if program.contains(std::path::MAIN_SEPARATOR) {
        return path.exists();
    }

    let path_var = match env::var_os("PATH") {
        Some(v) => v,
        None => return false,
    };
    #[cfg(windows)]
    let exts: Vec<String> = env::var("PATHEXT")
        .unwrap_or(".EXE;.CMD;.BAT;.COM".to_string())
        .split(';')
        .filter(|s| !s.is_empty())
        .map(|s| s.to_ascii_lowercase())
        .collect();

    for dir in env::split_paths(&path_var) {
        let candidate = dir.join(program);
        if candidate.exists() {
            return true;
        }
        #[cfg(windows)]
        {
            for ext in &exts {
                let with_ext = dir.join(format!("{program}{ext}"));
                if with_ext.exists() {
                    return true;
                }
            }
        }
    }
    false
}

#[cfg(windows)]
fn find_bundled_runtime_python(engine_dir: &Path) -> Option<PathBuf> {
    let root = engine_dir.join(".python_runtime");
    let direct = root.join("python.exe");
    if direct.exists() {
        return Some(direct);
    }
    let rd = fs::read_dir(&root).ok()?;
    for e in rd.flatten() {
        let p = e.path();
        if !p.is_dir() {
            continue;
        }
        let nested = p.join("python.exe");
        if nested.exists() {
            return Some(nested);
        }
    }
    None
}

#[cfg(not(windows))]
fn find_bundled_runtime_python(_engine_dir: &Path) -> Option<PathBuf> {
    None
}

fn resolve_python(engine_dir: &Path) -> Option<PythonLaunch> {
    let mut candidates = vec![
        PythonLaunch {
            program: engine_dir
                .join(".venv")
                .join("Scripts")
                .join("python.exe")
                .to_string_lossy()
                .to_string(),
            pre_args: vec![],
        },
        PythonLaunch {
            program: engine_dir
                .join(".venv")
                .join("bin")
                .join("python")
                .to_string_lossy()
                .to_string(),
            pre_args: vec![],
        },
        PythonLaunch {
            program: "/opt/homebrew/bin/python3.13".to_string(),
            pre_args: vec![],
        },
        PythonLaunch {
            program: "/usr/local/bin/python3.13".to_string(),
            pre_args: vec![],
        },
        PythonLaunch {
            program: "/usr/bin/python3".to_string(),
            pre_args: vec![],
        },
        PythonLaunch {
            program: "py".to_string(),
            pre_args: vec!["-3".to_string()],
        },
        PythonLaunch {
            program: "python3".to_string(),
            pre_args: vec![],
        },
        PythonLaunch {
            program: "python".to_string(),
            pre_args: vec![],
        },
    ];
    if let Some(p) = find_bundled_runtime_python(engine_dir) {
        candidates.insert(
            2,
            PythonLaunch {
                program: p.to_string_lossy().to_string(),
                pre_args: vec![],
            },
        );
    }

    candidates
        .into_iter()
        .find(|candidate| command_available(&candidate.program))
}

fn venv_python_path(engine_dir: &Path) -> PathBuf {
    #[cfg(windows)]
    {
        engine_dir.join(".venv").join("Scripts").join("python.exe")
    }
    #[cfg(not(windows))]
    {
        engine_dir.join(".venv").join("bin").join("python")
    }
}

fn run_logged_python_command(
    engine_dir: &Path,
    log_path: &Path,
    launch: &PythonLaunch,
    args: &[&str],
) -> Result<(), String> {
    let stdout_file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_path)
        .map_err(|e| format!("Failed to open engine log file: {e}"))?;
    let stderr_file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_path)
        .map_err(|e| format!("Failed to open engine log file: {e}"))?;

    let status = Command::new(&launch.program)
        .current_dir(engine_dir)
        .args(&launch.pre_args)
        .args(args)
        .stdout(Stdio::from(stdout_file))
        .stderr(Stdio::from(stderr_file))
        .status()
        .map_err(|e| format!("Failed to run python command {:?}: {e}", launch))?;

    if !status.success() {
        return Err(format!(
            "Python command failed with status {status}. Check log: {}",
            log_path.display()
        ));
    }
    Ok(())
}

fn python_launch_works(launch: &PythonLaunch) -> bool {
    Command::new(&launch.program)
        .args(&launch.pre_args)
        .arg("-c")
        .arg("import sys")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

fn python_module_available(launch: &PythonLaunch, module: &str) -> bool {
    let check = format!("import importlib.util,sys; sys.exit(0 if importlib.util.find_spec({module:?}) else 1)");
    Command::new(&launch.program)
        .args(&launch.pre_args)
        .arg("-c")
        .arg(check)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

#[cfg(windows)]
fn repair_windows_venv_cfg(engine_dir: &Path) -> Result<bool, String> {
    let cfg_path = engine_dir.join(".venv").join("pyvenv.cfg");
    let runtime_python = match find_bundled_runtime_python(engine_dir) {
        Some(p) => p,
        None => return Ok(false),
    };
    if !cfg_path.exists() || !runtime_python.exists() {
        return Ok(false);
    }

    let runtime_home = runtime_python
        .parent()
        .ok_or_else(|| "Bundled Python runtime path is invalid".to_string())?;
    let content = fs::read_to_string(&cfg_path)
        .map_err(|e| format!("Failed to read {}: {e}", cfg_path.display()))?;

    let mut out: Vec<String> = Vec::new();
    let mut touched = false;
    for raw in content.lines() {
        let trimmed = raw.trim_start().to_ascii_lowercase();
        if trimmed.starts_with("home =") {
            out.push(format!("home = {}", runtime_home.display()));
            touched = true;
        } else if trimmed.starts_with("executable =") {
            out.push(format!("executable = {}", runtime_python.display()));
            touched = true;
        } else if trimmed.starts_with("command =") {
            out.push(format!("command = {} -m venv .venv", runtime_python.display()));
            touched = true;
        } else {
            out.push(raw.to_string());
        }
    }

    if touched {
        fs::write(&cfg_path, out.join("\n") + "\n")
            .map_err(|e| format!("Failed to write {}: {e}", cfg_path.display()))?;
    }
    Ok(touched)
}

#[cfg(not(windows))]
fn repair_windows_venv_cfg(_engine_dir: &Path) -> Result<bool, String> {
    Ok(false)
}

fn ensure_engine_runtime(engine_dir: &Path, log_path: &Path) -> Result<PythonLaunch, String> {
    let venv_python = venv_python_path(engine_dir);
    let mut created_venv = false;
    let mut needs_bootstrap = !venv_python.exists();

    let venv_launch = PythonLaunch {
        program: venv_python.to_string_lossy().to_string(),
        pre_args: vec![],
    };

    if !needs_bootstrap && !python_launch_works(&venv_launch) {
        let _ = repair_windows_venv_cfg(engine_dir);
        if !python_launch_works(&venv_launch) {
            let _ = fs::remove_dir_all(engine_dir.join(".venv"));
            needs_bootstrap = true;
        }
    }

    if needs_bootstrap {
        let bootstrap = resolve_python(engine_dir).ok_or_else(|| {
            "Bundled Python runtime is missing and no system Python was found. Reinstall SplitLAB or use Advanced engine override.".to_string()
        })?;
        run_logged_python_command(engine_dir, log_path, &bootstrap, &["-m", "venv", ".venv"])?;
        created_venv = true;
    }

    if !python_launch_works(&venv_launch) {
        return Err(format!(
            "Python runtime is not usable at {}. Reinstall SplitLAB.",
            venv_python.display()
        ));
    }

    let marker = engine_dir.join(".venv").join(".splitlab_runtime_ready");
    if !marker.exists() {
        if created_venv {
            run_logged_python_command(
                engine_dir,
                log_path,
                &venv_launch,
                &["-m", "pip", "install", "--upgrade", "pip"],
            )?;
            run_logged_python_command(
                engine_dir,
                log_path,
                &venv_launch,
                &["-m", "pip", "install", "-r", "requirements.txt"],
            )?;
        }
        fs::write(&marker, b"ok")
            .map_err(|e| format!("Failed to write runtime marker {}: {e}", marker.display()))?;
    }

    #[cfg(windows)]
    {
        if !python_module_available(&venv_launch, "torchcodec") {
            run_logged_python_command(
                engine_dir,
                log_path,
                &venv_launch,
                &["-m", "pip", "install", "torchcodec"],
            )?;
            if !python_module_available(&venv_launch, "torchcodec") {
                return Err(
                    "Missing required dependency 'torchcodec' for Windows demucs runtime. Check engine log for pip output."
                        .to_string(),
                );
            }
        }
    }

    Ok(venv_launch)
}

fn score_stem_dir(dir: &Path) -> Option<(usize, std::time::SystemTime)> {
    let candidates = [
        "vocals.wav",
        "drums.wav",
        "bass.wav",
        "other.wav",
        "instrumental.wav",
    ];
    let mut count = 0usize;
    let mut newest = std::time::UNIX_EPOCH;
    for name in candidates {
        let p = dir.join(name);
        if p.exists() {
            count += 1;
            if let Ok(meta) = p.metadata() {
                if let Ok(m) = meta.modified() {
                    if m > newest {
                        newest = m;
                    }
                }
            }
        }
    }
    if count > 0 {
        Some((count, newest))
    } else {
        None
    }
}

#[tauri::command]
fn start_engine(engine_dir: Option<String>, port: Option<u16>) -> Result<String, String> {
    let port = port.unwrap_or(8732);
    let mut search_roots: Vec<PathBuf> = Vec::new();
    if let Some(raw) = engine_dir {
        let trimmed = raw.trim();
        if !trimmed.is_empty() {
            let requested = PathBuf::from(trimmed);
            if !requested.exists() || !requested.is_dir() {
                return Err("Engine folder does not exist or is not a directory".to_string());
            }
            search_roots.push(requested);
        }
    }
    search_roots.extend(default_engine_search_roots());

    let mut dir: Option<PathBuf> = None;
    for root in &search_roots {
        if let Some(found) = find_engine_dir(root) {
            dir = Some(found);
            break;
        }
    }
    let mut dir = dir.ok_or_else(|| {
        "Could not auto-detect engine/server.py. Install bundled engine or set Engine folder in Advanced settings."
            .to_string()
    })?;
    if should_materialize_engine(&dir) {
        dir = materialize_engine_dir(&dir)?;
    }

    let slot = engine_slot();
    {
        let mut guard = slot
            .lock()
            .map_err(|_| "Failed to lock engine state".to_string())?;

        if let Some(child) = guard.as_mut() {
            match child.try_wait() {
                Ok(None) => return Ok("Engine already running".to_string()),
                Ok(Some(_)) | Err(_) => {
                    *guard = None;
                }
            }
        }
    }

    let log_path = env::temp_dir().join("audiolab-splitter-engine.log");
    let python = ensure_engine_runtime(&dir, &log_path)?;

    let stdout_file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .map_err(|e| format!("Failed to open engine log file: {e}"))?;
    let stderr_file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .map_err(|e| format!("Failed to open engine log file: {e}"))?;

    let mut cmd = Command::new(&python.program);
    cmd.current_dir(&dir)
        .args(&python.pre_args)
        .arg("-m")
        .arg("uvicorn")
        .arg("server:app")
        .arg("--host")
        .arg("127.0.0.1")
        .arg("--port")
        .arg(port.to_string())
        .stdout(Stdio::from(stdout_file))
        .stderr(Stdio::from(stderr_file));

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to start engine process with {:?}: {e}", python))?;

    thread::sleep(Duration::from_millis(500));
    if let Ok(Some(status)) = child.try_wait() {
        return Err(format!(
            "Engine process exited immediately with status {status}. Check log: {}",
            log_path.display()
        ));
    }

    let mut guard = slot
        .lock()
        .map_err(|_| "Failed to lock engine state".to_string())?;
    *guard = Some(child);
    Ok(format!(
        "Engine process started from {} using {} (log: {})",
        dir.display(),
        python.program,
        log_path.display()
    ))
}

#[tauri::command]
fn stop_engine() -> Result<String, String> {
    let slot = engine_slot();
    let mut guard = slot
        .lock()
        .map_err(|_| "Failed to lock engine state".to_string())?;

    if let Some(mut child) = guard.take() {
        child
            .kill()
            .map_err(|e| format!("Failed to stop engine process: {e}"))?;
        let _ = child.wait();
        Ok("Engine process stopped".to_string())
    } else {
        Ok("No managed engine process to stop".to_string())
    }
}

#[tauri::command]
fn find_stems_dir(base_dir: String) -> Result<String, String> {
    let base = PathBuf::from(base_dir);
    if !base.exists() || !base.is_dir() {
        return Err("Selected folder does not exist or is not a directory".to_string());
    }

    let mut best_dir: Option<PathBuf> = None;
    let mut best_score: Option<(usize, std::time::SystemTime)> = None;

    let mut q: VecDeque<(PathBuf, usize)> = VecDeque::new();
    q.push_back((base.clone(), 0));
    let max_depth = 5usize;

    while let Some((dir, depth)) = q.pop_front() {
        if let Some(score) = score_stem_dir(&dir) {
            match best_score {
                None => {
                    best_score = Some(score);
                    best_dir = Some(dir.clone());
                }
                Some((best_count, best_time)) => {
                    if score.0 > best_count || (score.0 == best_count && score.1 > best_time) {
                        best_score = Some(score);
                        best_dir = Some(dir.clone());
                    }
                }
            }
        }
        if depth >= max_depth {
            continue;
        }
        let rd = match std::fs::read_dir(&dir) {
            Ok(v) => v,
            Err(_) => continue,
        };
        for e in rd.flatten() {
            let p = e.path();
            if p.is_dir() {
                q.push_back((p, depth + 1));
            }
        }
    }

    if let Some(path) = best_dir {
        Ok(path.to_string_lossy().to_string())
    } else {
        Err("No stems folder found recursively under selected folder".to_string())
    }
}

#[tauri::command]
fn read_binary_file(path: String) -> Result<Vec<u8>, String> {
    let p = PathBuf::from(path);
    if !p.exists() || !p.is_file() {
        return Err("File does not exist".to_string());
    }
    fs::read(&p).map_err(|e| format!("Failed to read file: {e}"))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            start_engine,
            stop_engine,
            find_stems_dir,
            read_binary_file,
            engine_location_hint
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
