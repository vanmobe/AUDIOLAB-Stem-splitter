import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { readFile } from "@tauri-apps/plugin-fs";
import { openPath } from "@tauri-apps/plugin-opener";

type Preset = "fast" | "best" | "vocal_boost";
type QualityMode = "fast" | "balanced" | "high";

interface JobStatus {
  id: string;
  status: string;
  progress: number;
  message: string;
  output_dir: string;
  stems_dir: string;
  preset: string;
  error?: string | null;
}

interface SelfCheckItem {
  key: string;
  status: "pass" | "warn" | "fail";
  message: string;
}

interface SelfCheckResponse {
  ok: boolean;
  checks: SelfCheckItem[];
  python_executable: string;
  python_version: string;
  demucs_backend?: string | null;
  demucs_command: string[];
  ffmpeg_path?: string | null;
  models_count: number;
  models: string[];
}

interface StemRow {
  name: string;
  root: HTMLDivElement;
  include: HTMLInputElement;
  audio: HTMLAudioElement;
  level: HTMLInputElement;
  status: HTMLSpanElement;
  available: boolean;
  buffer: AudioBuffer | null;
  gain: GainNode | null;
}

const BASE_URL = "http://127.0.0.1:8732";
const ENGINE_KEY = "audiolab.engineDir";
const OUTPUT_KEY = "audiolab.outputDir";
const STEMS_KEY = "audiolab.stemsDir";
const STEM_CANDIDATES = ["vocals", "drums", "bass", "other", "instrumental"];

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element #${id}`);
  return el as T;
};

const engineDirEl = $<HTMLInputElement>("engine-dir");
const inputFileEl = $<HTMLInputElement>("input-file");
const outputDirEl = $<HTMLInputElement>("output-dir");
const playerStemsDirEl = $<HTMLInputElement>("player-stems-dir");
const stemsEl = $<HTMLSelectElement>("stems");
const presetEl = $<HTMLSelectElement>("preset");
const qualityModeEl = $<HTMLSelectElement>("quality-mode");
const modelEl = $<HTMLSelectElement>("model");
const ensembleModelEl = $<HTMLSelectElement>("ensemble-model");
const modelHelpEl = $<HTMLParagraphElement>("model-help");
const ensembleHelpEl = $<HTMLParagraphElement>("ensemble-help");
const engineStatusEl = $<HTMLParagraphElement>("engine-status");
const selfCheckStatusEl = $<HTMLParagraphElement>("self-check-status");
const selfCheckListEl = $<HTMLUListElement>("self-check-list");
const step1StateEl = $<HTMLSpanElement>("step1-state");
const step2StateEl = $<HTMLSpanElement>("step2-state");
const step3StateEl = $<HTMLSpanElement>("step3-state");
const step4StateEl = $<HTMLSpanElement>("step4-state");
const jobStatusEl = $<HTMLParagraphElement>("job-status");
const progressEl = $<HTMLProgressElement>("progress");
const progressLabelEl = $<HTMLSpanElement>("progress-label");
const logEl = $<HTMLPreElement>("log");
const stemListEl = $<HTMLDivElement>("stem-list");
const tabSplitterBtn = $<HTMLButtonElement>("tab-splitter");
const tabPlayerBtn = $<HTMLButtonElement>("tab-player");
const tabGuideBtn = $<HTMLButtonElement>("tab-guide");
const panelSplitter = $<HTMLElement>("panel-splitter");
const panelPlayer = $<HTMLElement>("panel-player");
const panelGuide = $<HTMLElement>("panel-guide");

const startJobBtn = $<HTMLButtonElement>("start-job");
const attachJobBtn = $<HTMLButtonElement>("attach-job");
const startEngineBtn = $<HTMLButtonElement>("start-engine");
const stopEngineBtn = $<HTMLButtonElement>("stop-engine");

let isRunningJob = false;
let lastStemsDir = "";
const stemRows: StemRow[] = [];
let audioCtx: AudioContext | null = null;
let isPlaying = false;
let playOffsetSec = 0;
let playStartCtxSec = 0;
let playingRows: StemRow[] = [];
const activeSources = new Map<string, AudioBufferSourceNode>();

function log(msg: string): void {
  const stamp = new Date().toLocaleTimeString();
  logEl.textContent = `[${stamp}] ${msg}\n${logEl.textContent}`;
}

function setEngineStatus(msg: string): void {
  engineStatusEl.textContent = `Engine status: ${msg}`;
  const lower = msg.toLowerCase();
  if (lower.includes("running")) {
    setStepState(step1StateEl, "running", "ok");
  } else if (lower.includes("starting")) {
    setStepState(step1StateEl, "starting", "warn");
  } else if (lower.includes("failed") || lower.includes("error") || lower.includes("not reachable")) {
    setStepState(step1StateEl, "offline", "fail");
  } else {
    setStepState(step1StateEl, "unknown");
  }
}

function setSelfCheckStatus(msg: string): void {
  selfCheckStatusEl.textContent = `Diagnostics: ${msg}`;
  const lower = msg.toLowerCase();
  if (lower.startsWith("ready")) {
    setStepState(step2StateEl, "ready", "ok");
  } else if (lower.includes("running")) {
    setStepState(step2StateEl, "running", "warn");
  } else if (lower.includes("issues")) {
    setStepState(step2StateEl, "issues", "warn");
  } else if (lower.includes("error")) {
    setStepState(step2StateEl, "error", "fail");
  } else {
    setStepState(step2StateEl, "not run");
  }
}

function setJobStatus(msg: string): void {
  jobStatusEl.textContent = `Job status: ${msg}`;
  const lower = msg.toLowerCase();
  if (lower.startsWith("done")) {
    setStepState(step3StateEl, "done", "ok");
  } else if (lower.startsWith("error")) {
    setStepState(step3StateEl, "error", "fail");
  } else if (lower.startsWith("running") || lower.startsWith("queued")) {
    setStepState(step3StateEl, "running", "warn");
  } else if (lower.startsWith("idle")) {
    setStepState(step3StateEl, "idle");
  } else {
    setStepState(step3StateEl, "active", "warn");
  }
}

function setStepState(
  el: HTMLElement,
  text: string,
  kind: "ok" | "warn" | "fail" | "" = ""
): void {
  el.textContent = text;
  el.classList.remove("ok", "warn", "fail");
  if (kind) el.classList.add(kind);
}

function setBusy(state: boolean): void {
  isRunningJob = state;
  startJobBtn.disabled = state;
}

function setTab(tab: "splitter" | "player" | "guide"): void {
  tabSplitterBtn.classList.toggle("active", tab === "splitter");
  tabPlayerBtn.classList.toggle("active", tab === "player");
  tabGuideBtn.classList.toggle("active", tab === "guide");
  panelSplitter.classList.toggle("active", tab === "splitter");
  panelPlayer.classList.toggle("active", tab === "player");
  panelGuide.classList.toggle("active", tab === "guide");
}

function saveEngineDir(path: string): void {
  localStorage.setItem(ENGINE_KEY, path);
}

function saveOutputDir(path: string): void {
  localStorage.setItem(OUTPUT_KEY, path);
}

function saveStemsDir(path: string): void {
  localStorage.setItem(STEMS_KEY, path);
}

function loadEngineDir(): void {
  const existing = localStorage.getItem(ENGINE_KEY);
  if (existing) engineDirEl.value = existing;
}

function loadOutputDir(): void {
  const existing = localStorage.getItem(OUTPUT_KEY);
  if (existing) outputDirEl.value = existing;
}

function loadStemsDir(): void {
  const existing = localStorage.getItem(STEMS_KEY);
  if (existing) {
    lastStemsDir = existing;
    playerStemsDirEl.value = existing;
  }
}

async function parseError(resp: Response): Promise<Error> {
  const txt = await resp.text();
  try {
    const j = JSON.parse(txt) as { detail?: string };
    return new Error(j.detail ?? txt);
  } catch {
    return new Error(txt);
  }
}

async function healthCheck(): Promise<boolean> {
  try {
    const resp = await fetch(`${BASE_URL}/health`);
    if (!resp.ok) return false;
    const data = await resp.json();
    return Boolean(data?.ok);
  } catch {
    return false;
  }
}

async function checkEngine(): Promise<void> {
  const ok = await healthCheck();
  if (ok) {
    setEngineStatus("running");
    log("Engine health check succeeded.");
    try {
      await runSelfCheck();
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      setSelfCheckStatus(`error | ${text}`);
      log(`Self-check failed: ${text}`);
    }
  } else {
    setEngineStatus("not reachable on 127.0.0.1:8732");
    log("Engine health check failed.");
    setSelfCheckStatus("engine not reachable");
    selfCheckListEl.innerHTML = "";
  }
}

async function ensureEngine(): Promise<void> {
  if (await healthCheck()) {
    setEngineStatus("running");
    return;
  }

  const engineDir = engineDirEl.value.trim();
  setEngineStatus("starting...");
  const result = await invoke<string>("start_engine", {
    engineDir: engineDir || null,
    port: 8732,
  });
  log(result);

  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (await healthCheck()) {
      setEngineStatus("running");
      return;
    }
    await delay(400);
  }
  setEngineStatus("start failed");
  throw new Error("Engine did not become healthy within 15 seconds.");
}

async function stopEngine(): Promise<void> {
  const result = await invoke<string>("stop_engine");
  log(result);
  await checkEngine();
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pickDirectory(target: HTMLInputElement): Promise<void> {
  const picked = await openDialog({ directory: true, multiple: false, title: "Select folder" });
  if (typeof picked === "string") {
    target.value = picked;
    if (target === engineDirEl) saveEngineDir(picked);
    if (target === outputDirEl) saveOutputDir(picked);
    if (target === playerStemsDirEl) saveStemsDir(picked);
  }
}

async function pickInputFile(): Promise<void> {
  const picked = await openDialog({
    directory: false,
    multiple: false,
    title: "Select audio file",
    filters: [{ name: "Audio", extensions: ["wav", "mp3", "flac", "m4a", "ogg", "aif", "aiff"] }],
  });

  if (typeof picked === "string") {
    inputFileEl.value = picked;
  }
}

async function postSeparate(payload: {
  input_path: string;
  output_dir: string;
  stems: number;
  preset: Preset;
  quality_mode: QualityMode;
  model?: string | null;
  ensemble_model?: string | null;
}): Promise<JobStatus> {
  let resp: Response;
  try {
    resp = await fetch(`${BASE_URL}/separate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch {
    throw new Error("Engine unreachable. Start the engine and try again.");
  }
  if (!resp.ok) {
    throw await parseError(resp);
  }
  return (await resp.json()) as JobStatus;
}

async function getJob(jobId: string): Promise<JobStatus> {
  let resp: Response;
  try {
    resp = await fetch(`${BASE_URL}/jobs/${jobId}`);
  } catch {
    throw new Error("Lost connection to engine while polling job status.");
  }
  if (!resp.ok) {
    throw await parseError(resp);
  }
  return (await resp.json()) as JobStatus;
}

async function getActiveJob(): Promise<JobStatus> {
  let resp: Response;
  try {
    resp = await fetch(`${BASE_URL}/active-job`);
  } catch {
    throw new Error("Engine unreachable while checking active jobs.");
  }
  if (!resp.ok) {
    throw await parseError(resp);
  }
  return (await resp.json()) as JobStatus;
}

async function getModels(): Promise<string[]> {
  const resp = await fetch(`${BASE_URL}/models`);
  if (!resp.ok) {
    throw await parseError(resp);
  }
  const data = (await resp.json()) as { models?: string[] };
  return data.models ?? [];
}

async function getSelfCheck(): Promise<SelfCheckResponse> {
  const resp = await fetch(`${BASE_URL}/self-check`);
  if (!resp.ok) {
    throw await parseError(resp);
  }
  return (await resp.json()) as SelfCheckResponse;
}

function renderSelfCheck(data: SelfCheckResponse): void {
  selfCheckListEl.innerHTML = "";
  setSelfCheckStatus(
    data.ok
      ? `ready (${data.demucs_backend ?? "unknown"} backend, ${data.models_count} models)`
      : "issues found"
  );
  for (const check of data.checks) {
    const item = document.createElement("li");
    item.className = `check-item ${check.status}`;
    const prefix =
      check.status === "pass" ? "PASS" : check.status === "warn" ? "WARN" : "FAIL";
    item.textContent = `${prefix} | ${check.key}: ${check.message}`;
    selfCheckListEl.appendChild(item);
  }
}

async function runSelfCheck(): Promise<void> {
  setSelfCheckStatus("running...");
  const report = await getSelfCheck();
  renderSelfCheck(report);
  log(
    `Self-check: ${report.ok ? "ok" : "issues"} | backend=${report.demucs_backend ?? "n/a"} | models=${report.models_count}`
  );
}

function setModelOptions(models: string[]): void {
  modelEl.innerHTML = `<option value="">Default</option>`;
  ensembleModelEl.innerHTML = `<option value="">None</option>`;
  for (const m of models) {
    const opt1 = document.createElement("option");
    opt1.value = m;
    opt1.textContent = m;
    modelEl.appendChild(opt1);

    const opt2 = document.createElement("option");
    opt2.value = m;
    opt2.textContent = m;
    ensembleModelEl.appendChild(opt2);
  }
}

function describeModel(name: string, isEnsemble: boolean): string {
  const n = name.trim().toLowerCase();
  if (!n) {
    return isEnsemble
      ? "No ensemble model selected. This keeps runtime lower and is good for quick iteration. Add an ensemble model when you want cleaner stems and can accept longer processing time."
      : "Default model will be used. This is usually a balanced starting point for mixed music content. If artifacts remain, try a fine-tuned model or enable an ensemble model.";
  }
  if (n.includes("htdemucs_ft")) {
    return "HTDemucs FT is a fine-tuned variant focused on higher quality separation, especially for vocals and dense mixes. It usually gives cleaner stems than faster models, but takes more compute time. Good choice for final exports when quality matters most.";
  }
  if (n.includes("htdemucs")) {
    return "HTDemucs is a strong general-purpose model with a good quality/speed balance for many genres. It tends to preserve musical detail while keeping artifacts reasonably low. Use this as a reliable default when you are unsure.";
  }
  if (n.includes("mdx_extra")) {
    return "MDX Extra is often effective on vocals and can reduce bleed in difficult tracks. It can sound more aggressive than Demucs-style models on some material, so compare results by ear. Great as an ensemble partner when vocals need extra clarity.";
  }
  if (n.includes("mdx")) {
    return "MDX-family models can perform well for vocal-centric separation and specific source profiles. They are useful alternatives when standard Demucs output still has leakage. Try them when you want a different artifact profile rather than a pure quality jump.";
  }
  return "This model has its own separation character and may perform differently per genre and mix style. For best results, run a short A/B test against your current choice. If quality is close, prefer the faster model for iteration and add ensemble only for final renders.";
}

function refreshModelHelp(): void {
  modelHelpEl.textContent = describeModel(modelEl.value, false);
  ensembleHelpEl.textContent = describeModel(ensembleModelEl.value, true);
}

async function refreshModels(): Promise<void> {
  await ensureEngine();
  const models = await getModels();
  setModelOptions(models);
  refreshModelHelp();
  log(`Loaded ${models.length} model(s).`);
  await runSelfCheck();
}

function updateProgress(job: JobStatus): void {
  const pct = Math.max(0, Math.min(100, Math.round(job.progress * 100)));
  progressEl.value = pct;
  progressLabelEl.textContent = `${pct}%`;
  setJobStatus(`${job.status} | ${job.message}`);
}

function joinPath(dir: string, name: string): string {
  if (dir.endsWith("/") || dir.endsWith("\\")) return `${dir}${name}`;
  return dir.includes("\\") ? `${dir}\\${name}` : `${dir}/${name}`;
}

function ensureAudioContext(): AudioContext {
  if (!audioCtx) {
    audioCtx = new AudioContext();
  }
  return audioCtx;
}

function computeStemGain(row: StemRow): number {
  const enabled = row.available && row.include.checked;
  const level = Math.max(0, Math.min(100, Number(row.level.value))) / 100;
  return enabled ? level : 0;
}

function updateStemGain(row: StemRow): void {
  const gainValue = computeStemGain(row);
  if (row.gain) {
    row.gain.gain.value = gainValue;
  }
  row.audio.volume = gainValue;
  row.audio.muted = gainValue === 0;
}

function updateAllStemGains(): void {
  for (const row of stemRows) {
    updateStemGain(row);
  }
}

function stopActiveSources(): void {
  for (const source of activeSources.values()) {
    try {
      source.stop();
    } catch {
      // Source may already be ended.
    }
    try {
      source.disconnect();
    } catch {
      // no-op
    }
  }
  activeSources.clear();
}

function clampOffsetForRows(rows: StemRow[], offset: number): number {
  const durations = rows
    .map((r) => r.buffer?.duration ?? 0)
    .filter((d) => Number.isFinite(d) && d > 0);
  if (durations.length === 0) return 0;
  const maxOffset = Math.max(0, Math.min(...durations) - 0.02);
  return Math.max(0, Math.min(offset, maxOffset));
}

function createStemRows(): void {
  stemListEl.innerHTML = "";
  stemRows.length = 0;

  for (const name of STEM_CANDIDATES) {
    const root = document.createElement("div");
    root.className = "stem-row disabled";

    const label = document.createElement("label");
    const include = document.createElement("input");
    include.type = "checkbox";
    include.checked = name === "vocals" || name === "instrumental";
    const text = document.createElement("span");
    text.textContent = name;
    label.appendChild(include);
    label.appendChild(text);

    const audio = document.createElement("audio");
    audio.controls = false;
    audio.preload = "metadata";
    audio.style.display = "none";

    const levelWrap = document.createElement("div");
    const level = document.createElement("input");
    level.type = "range";
    level.min = "0";
    level.max = "100";
    level.value = "100";
    const status = document.createElement("span");
    status.textContent = "not loaded";
    status.className = "status";
    levelWrap.appendChild(level);
    levelWrap.appendChild(status);

    root.appendChild(label);
    root.appendChild(audio);
    root.appendChild(levelWrap);
    stemListEl.appendChild(root);

    const row: StemRow = {
      name,
      root,
      include,
      audio,
      level,
      status,
      available: false,
      buffer: null,
      gain: null,
    };

    include.addEventListener("change", () => updateStemGain(row));
    level.addEventListener("input", () => updateStemGain(row));
    stemRows.push(row);
  }
}

function clearStemRows(): void {
  stopAllStems();
  for (const row of stemRows) {
    row.audio.pause();
    row.audio.removeAttribute("src");
    row.audio.load();
    row.buffer = null;
    row.gain = null;
    row.available = false;
    row.root.classList.add("disabled");
    row.status.textContent = "not loaded";
    updateStemGain(row);
  }
  setStepState(step4StateEl, "not loaded");
}

async function loadStemsFromDir(stemsDir: string): Promise<void> {
  if (!stemsDir) throw new Error("No stems directory available yet.");
  lastStemsDir = stemsDir;
  playerStemsDirEl.value = stemsDir;
  saveStemsDir(stemsDir);
  clearStemRows();
  const candidateDirs = [stemsDir, joinPath(stemsDir, "stems")];
  try {
    const discovered = await invoke<string>("find_stems_dir", { baseDir: stemsDir });
    if (!candidateDirs.includes(discovered)) {
      candidateDirs.push(discovered);
    }
  } catch {
    // Discovery is best-effort.
  }
  let chosenDir: string | null = null;
  let loaded = 0;

  const loadOne = async (row: StemRow): Promise<boolean> => {
    row.available = false;
    row.buffer = null;
    row.gain = null;
    row.root.classList.add("disabled");
    row.status.textContent = "loading...";
    for (const baseDir of candidateDirs) {
      const filePath = joinPath(baseDir, `${row.name}.wav`);
      try {
        const ctx = ensureAudioContext();
        const t0 = performance.now();
        const bytes = await readFile(filePath);
        const t1 = performance.now();
        const arr = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
        row.buffer = await ctx.decodeAudioData(arr);
        const t2 = performance.now();
        row.available = true;
        chosenDir = chosenDir ?? baseDir;
        row.root.classList.remove("disabled");
        const readMs = Math.round(t1 - t0);
        const decodeMs = Math.round(t2 - t1);
        const totalMs = readMs + decodeMs;
        row.status.textContent = `ready (${row.buffer.duration.toFixed(1)}s, ${totalMs}ms)`;
        log(
          `Stem loaded: ${row.name} | read ${readMs}ms | decode ${decodeMs}ms | total ${totalMs}ms`
        );
        updateStemGain(row);
        return true;
      } catch {
        // try next candidate folder
      }
    }
    row.status.textContent = "missing";
    updateStemGain(row);
    return false;
  };

  const results = await Promise.all(stemRows.map((row) => loadOne(row)));
  loaded = results.filter(Boolean).length;

  if (loaded === 0) {
    throw new Error(
      `No stems found. Searched: ${candidateDirs.join(" | ")}`
    );
  }
  if (loaded > 0) {
    lastStemsDir = chosenDir ?? stemsDir;
    playerStemsDirEl.value = lastStemsDir;
    saveStemsDir(lastStemsDir);
  }
  setStepState(step4StateEl, `${loaded} loaded`, "ok");
  log(`Loaded ${loaded} stem(s) from ${lastStemsDir}`);
}

async function loadStemsFromPreferredDir(): Promise<void> {
  const dir = playerStemsDirEl.value.trim() || lastStemsDir || outputDirEl.value.trim();
  if (!dir) throw new Error("Choose a stems/output folder first.");
  await loadStemsFromDir(dir);
  setTab("player");
}

async function autoLoadSavedStems(): Promise<void> {
  const saved = playerStemsDirEl.value.trim() || lastStemsDir;
  if (!saved) return;
  try {
    await loadStemsFromDir(saved);
    setTab("player");
    log(`Auto-loaded stems from ${saved}`);
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err);
    log(`Auto-load skipped: ${text}`);
  }
}

async function playSelectedStems(): Promise<void> {
  const available = stemRows.filter((r) => r.available);
  if (available.length === 0) {
    throw new Error("No loaded stems available to play.");
  }

  const selected = available.filter((r) => r.include.checked);
  if (selected.length === 0) {
    throw new Error("No stems selected. Tick at least one stem.");
  }
  if (selected.some((r) => !r.buffer)) {
    throw new Error("Some selected stems are not decoded yet.");
  }

  const ctx = ensureAudioContext();
  if (ctx.state === "suspended") {
    await ctx.resume();
  }

  stopActiveSources();
  const offset = clampOffsetForRows(selected, playOffsetSec);
  const startAt = ctx.currentTime + 0.05;

  for (const row of selected) {
    const source = ctx.createBufferSource();
    source.buffer = row.buffer;
    if (!row.gain) {
      row.gain = ctx.createGain();
      row.gain.connect(ctx.destination);
    }
    row.gain.gain.value = computeStemGain(row);
    source.connect(row.gain);
    source.onended = () => {
      if (activeSources.get(row.name) !== source) return;
      activeSources.delete(row.name);
      if (activeSources.size === 0 && isPlaying) {
        isPlaying = false;
        playOffsetSec = 0;
        playStartCtxSec = 0;
        playingRows = [];
        for (const r of stemRows) {
          if (r.available) r.status.textContent = "ready";
        }
        const loaded = stemRows.filter((r) => r.available).length;
        if (loaded > 0) {
          setStepState(step4StateEl, `${loaded} loaded`, "ok");
        }
      }
    };
    source.start(startAt, offset);
    activeSources.set(row.name, source);
  }

  isPlaying = true;
  playOffsetSec = offset;
  playStartCtxSec = startAt;
  playingRows = selected;

  for (const row of selected) {
    row.status.textContent = "playing";
  }
  setStepState(step4StateEl, "playing", "warn");
}

function pauseAllStems(): void {
  if (!isPlaying) return;
  const ctx = ensureAudioContext();
  const elapsed = Math.max(0, ctx.currentTime - playStartCtxSec);
  playOffsetSec = clampOffsetForRows(playingRows, playOffsetSec + elapsed);
  stopActiveSources();
  isPlaying = false;
  for (const row of stemRows) {
    if (row.available) row.status.textContent = "paused";
  }
  setStepState(step4StateEl, "paused");
}

function stopAllStems(): void {
  stopActiveSources();
  isPlaying = false;
  playOffsetSec = 0;
  playStartCtxSec = 0;
  playingRows = [];
  for (const row of stemRows) {
    if (row.available) {
      row.status.textContent = "ready";
    }
  }
  const loaded = stemRows.filter((r) => r.available).length;
  if (loaded > 0) {
    setStepState(step4StateEl, `${loaded} loaded`, "ok");
  } else {
    setStepState(step4StateEl, "not loaded");
  }
}

async function startSplit(): Promise<void> {
  if (isRunningJob) return;
  const inputPath = inputFileEl.value.trim();
  const outputDir = outputDirEl.value.trim();
  const stems = Number(stemsEl.value);
  const preset = presetEl.value as Preset;
  const qualityMode = qualityModeEl.value as QualityMode;
  const model = modelEl.value.trim();
  const ensembleModel = ensembleModelEl.value.trim();

  if (!inputPath) throw new Error("Choose an input audio file.");
  if (!outputDir) throw new Error("Choose an output folder.");

  setBusy(true);
  progressEl.value = 0;
  progressLabelEl.textContent = "0%";

  try {
    await ensureEngine();
    const initial = await postSeparate({
      input_path: inputPath,
      output_dir: outputDir,
      stems,
      preset,
      quality_mode: qualityMode,
      model: model || null,
      ensemble_model: ensembleModel || null,
    });
    log(`Job started: ${initial.id}`);
    updateProgress(initial);
    await watchJob(initial.id);
  } finally {
    setBusy(false);
  }
}

async function watchJob(jobId: string): Promise<void> {
  let pollFailures = 0;
  while (true) {
    await delay(1000);
    let job: JobStatus;
    try {
      job = await getJob(jobId);
      pollFailures = 0;
    } catch (err) {
      pollFailures += 1;
      if (pollFailures < 4) {
        setJobStatus("running | reconnecting to engine…");
        continue;
      }
      throw err;
    }
    updateProgress(job);
    if (job.status === "done") {
      log(`Job complete. Stems: ${job.stems_dir}`);
      setJobStatus(`done | output: ${job.stems_dir}`);
      await loadStemsFromDir(job.stems_dir);
      setTab("player");
      break;
    }
    if (job.status === "error") {
      throw new Error(job.error ?? "Unknown engine error");
    }
  }
}

window.addEventListener("DOMContentLoaded", () => {
  createStemRows();
  loadEngineDir();
  loadOutputDir();
  loadStemsDir();
  checkEngine().catch((err) => log(String(err)));

  $("pick-engine-dir").addEventListener("click", () => {
    pickDirectory(engineDirEl).catch((err) => log(String(err)));
  });
  $("pick-input-file").addEventListener("click", () => {
    pickInputFile().catch((err) => log(String(err)));
  });
  $("pick-output-dir").addEventListener("click", () => {
    pickDirectory(outputDirEl).catch((err) => log(String(err)));
  });
  $("pick-player-stems-dir").addEventListener("click", () => {
    pickDirectory(playerStemsDirEl).catch((err) => log(String(err)));
  });
  $("check-engine").addEventListener("click", () => {
    checkEngine().catch((err) => log(String(err)));
  });
  startEngineBtn.addEventListener("click", async () => {
    try {
      await ensureEngine();
      log("Engine is ready.");
      await runSelfCheck();
    } catch (err) {
      log(`Failed to start engine: ${String(err)}`);
      setEngineStatus("error");
      setSelfCheckStatus(`error | ${String(err)}`);
    }
  });
  stopEngineBtn.addEventListener("click", () => {
    stopEngine().catch((err) => log(String(err)));
  });
  $("open-output").addEventListener("click", () => {
    const out = outputDirEl.value.trim();
    if (out) {
      openPath(out).catch((err) => log(String(err)));
    }
  });
  $("refresh-models").addEventListener("click", () => {
    refreshModels().catch((err) => {
      const text = err instanceof Error ? err.message : String(err);
      log(`Failed to refresh models: ${text}`);
    });
  });
  $("run-self-check").addEventListener("click", () => {
    ensureEngine()
      .then(() => runSelfCheck())
      .catch((err) => {
        const text = err instanceof Error ? err.message : String(err);
        setSelfCheckStatus(`error | ${text}`);
        log(`Self-check failed: ${text}`);
      });
  });
  attachJobBtn.addEventListener("click", async () => {
    if (isRunningJob) return;
    try {
      setBusy(true);
      await ensureEngine();
      const active = await getActiveJob();
      log(`Attached to active job: ${active.id}`);
      updateProgress(active);
      await watchJob(active.id);
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      setJobStatus(`idle | ${text}`);
      log(`Attach failed: ${text}`);
    } finally {
      setBusy(false);
    }
  });
  $("load-stems").addEventListener("click", async () => {
    try {
      await loadStemsFromPreferredDir();
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      log(`Failed to load stems: ${text}`);
    }
  });
  $("load-stems-player").addEventListener("click", async () => {
    try {
      await loadStemsFromPreferredDir();
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      log(`Failed to load stems: ${text}`);
    }
  });
  $("play-selected").addEventListener("click", () => {
    playSelectedStems().catch((err) => {
      const text = err instanceof Error ? err.message : String(err);
      log(`Play failed: ${text}`);
    });
  });
  $("pause-selected").addEventListener("click", () => pauseAllStems());
  $("stop-selected").addEventListener("click", () => stopAllStems());
  $("select-all-stems").addEventListener("click", () => {
    for (const row of stemRows) row.include.checked = true;
    updateAllStemGains();
  });
  $("select-none-stems").addEventListener("click", () => {
    for (const row of stemRows) row.include.checked = false;
    updateAllStemGains();
  });
  tabSplitterBtn.addEventListener("click", () => setTab("splitter"));
  tabPlayerBtn.addEventListener("click", () => setTab("player"));
  tabGuideBtn.addEventListener("click", () => setTab("guide"));
  modelEl.addEventListener("change", () => refreshModelHelp());
  ensembleModelEl.addEventListener("change", () => refreshModelHelp());

  startJobBtn.addEventListener("click", async () => {
    try {
      await startSplit();
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      setJobStatus(`error | ${text}`);
      log(`Job failed: ${text}`);
    }
  });

  engineDirEl.addEventListener("change", () => saveEngineDir(engineDirEl.value.trim()));
  outputDirEl.addEventListener("change", () => saveOutputDir(outputDirEl.value.trim()));
  playerStemsDirEl.addEventListener("change", () => saveStemsDir(playerStemsDirEl.value.trim()));
  refreshModels().catch((err) => {
    log(`Model list unavailable yet: ${String(err)}`);
  });
  refreshModelHelp();
  getActiveJob()
    .then(async (active) => {
      if (active.status === "running" || active.status === "queued") {
        log(`Found active job on startup: ${active.id}`);
        updateProgress(active);
        setBusy(true);
        try {
          await watchJob(active.id);
        } finally {
          setBusy(false);
        }
      } else {
        await autoLoadSavedStems();
      }
    })
    .catch(() => {
      // No active job is normal.
      autoLoadSavedStems().catch(() => {
        // best-effort only
      });
    });
});
