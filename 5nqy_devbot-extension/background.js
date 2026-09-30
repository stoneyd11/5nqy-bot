// SPDX-License-Identifier: GPL-3.0-or-later
// background.js - service worker.
// Owns ONE resilient WebSocket to the local bridge (ws://127.0.0.1:PORT).
// Keeping the socket here (not in the content script) avoids https→ws mixed
// content issues and centralises reconnect / timeout logic.
//
// Contract with content.js: every sendMessage ALWAYS gets a response object,
// even when the bridge is offline. The agentic loop must never hang waiting.

try { importScripts("core/provider-registry.js"); } catch (e) { console.warn("[5nqy_devbot] provider registry unavailable", e); }

const PORT = 17613;
const URL = `ws://127.0.0.1:${PORT}`;

// Chat sites where a 5nqy_devbot provider content script runs. Status pushes go
// to every tab matching these. Add the new provider's URL pattern here (and in
// manifest.json content_scripts + host_permissions) when integrating another AI.
const PROVIDER_URLS = ["https://claude.ai/*", "https://chat.deepseek.com/*", "https://chatgpt.com/*", "https://chat.openai.com/*", "https://gemini.google.com/*", "https://www.kimi.ai/*", "https://kimi.ai/*", "https://chat.z.ai/*", "https://chat.qwen.ai/*", "https://arena.ai/*", "https://www.meta.ai/*", "https://meta.ai/*"];

const RECONNECT_MIN = 1000;
const RECONNECT_MAX = 5000;
const HEARTBEAT_MS = 10000;
// If no message (incl. pong) arrives within this window while we believe we're
// connected, the socket is half-open: force a reconnect instead of letting
// pending requests slowly time out.
const STALE_SOCKET_MS = 25000;
const REQUEST_TIMEOUT_DEFAULT = 130000; // a bit above the 120s tool timeout

let ws = null;
let connected = false;
let reconnectDelay = RECONNECT_MIN;
let reconnectTimer = null;
let heartbeatTimer = null;
let lastMessageAt = 0; // timestamp of the last frame received from the bridge
let nextId = 1;
const pending = new Map(); // id -> {resolve, timer}
let toolsCache = [];
let mcpAlive = false;
let serversCache = [];
// true/false = a PLACE is loaded and usable in Roblox Studio; null = unknown.
// The MCP process stays alive when Studio is closed or its MCP option is off,
// so this is probed separately (bridge "studio_status").
let studioConnected = null;
// true/false = a Roblox Studio app is connected to the MCP server at all; null =
// unknown. studioApp=true with studioConnected=false means "Studio open but no
// place"; studioApp=false means "Studio closed OR its MCP option disabled".
let studioApp = null;
// true/false = a Roblox Studio WINDOW/PROCESS exists on this machine (checked
// bridge-side via tasklist); null = unknown/old bridge. Distinguishes the two
// studioApp=false sub-cases the UI must word differently: Studio genuinely not
// launched ("open Roblox Studio") vs Studio OPEN but its MCP plugin never
// registered with the bridge - the documented fix for the latter is opening
// Assistant Settings > MCP Servers inside Studio (validated live 3x), which
// "open Roblox Studio" wording completely fails to convey.
let studioProc = null;

function log(...a) {
  console.log("[zs-bg]", ...a);
}

// ── WebSocket lifecycle ─────────────────────────────────────────────────
function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }
  clearTimeout(reconnectTimer);
  try {
    ws = new WebSocket(URL);
  } catch (e) {
    log("WebSocket ctor failed", e);
    scheduleReconnect();
    return;
  }

  ws.onopen = () => {
    connected = true;
    reconnectDelay = RECONNECT_MIN;
    lastMessageAt = Date.now();
    log("connected to bridge");
    startHeartbeat();
    broadcastStatus();
  };

  ws.onmessage = (ev) => {
    lastMessageAt = Date.now();
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    handleBridgeMessage(msg);
  };

  ws.onclose = () => {
    connected = false;
    mcpAlive = false;
    studioConnected = null;
    studioApp = null;
    studioProc = null;
    serversCache = [];
    stopHeartbeat();
    failAllPending("bridge connection closed");
    broadcastStatus();
    scheduleReconnect();
  };

  ws.onerror = () => {
    // onclose will follow; nothing to do here but avoid an unhandled error.
    try { ws.close(); } catch {}
  };
}

function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connect, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 1.7, RECONNECT_MAX);
}

function startHeartbeat() {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => {
    if (connected) {
      // Half-open socket: the WS still reports OPEN but nothing comes through.
      // The pong (and every other frame) refreshes lastMessageAt; if it has
      // gone stale, drop the dead socket so onclose triggers a reconnect.
      if (lastMessageAt && Date.now() - lastMessageAt > STALE_SOCKET_MS) {
        log("socket stale, forcing reconnect");
        try { ws.close(); } catch {}
        return;
      }
      // Keeps the MV3 service worker alive AND detects a half-open socket.
      send({ type: "ping" }).catch(() => {});
      refreshStudioStatus();
    }
  }, HEARTBEAT_MS);
}

function stopHeartbeat() {
  clearInterval(heartbeatTimer);
  heartbeatTimer = null;
}

// Resolve once the socket is OPEN, or false after `timeout` ms.
function waitForConnection(timeout = 8000) {
  return new Promise((resolve) => {
    if (connected && ws && ws.readyState === WebSocket.OPEN) return resolve(true);
    connect(); // nudge a (re)connection - important after a worker wake-up
    const t0 = Date.now();
    const iv = setInterval(() => {
      if (connected && ws && ws.readyState === WebSocket.OPEN) {
        clearInterval(iv);
        resolve(true);
      } else if (Date.now() - t0 > timeout) {
        clearInterval(iv);
        resolve(false);
      }
    }, 100);
  });
}

// ── request/response over the socket ────────────────────────────────────
async function send(obj, timeout = REQUEST_TIMEOUT_DEFAULT) {
  // The MV3 service worker can be suspended; the first message after a wake-up
  // arrives before the socket has re-opened. Wait for it instead of failing -
  // otherwise Kimi wrongly hears "bridge offline".
  if (!connected || !ws || ws.readyState !== WebSocket.OPEN) {
    await waitForConnection(8000);
  }
  return new Promise((resolve) => {
    if (!connected || !ws || ws.readyState !== WebSocket.OPEN) {
      resolve({ ok: false, kind: "disconnected", error: "bridge not connected" });
      return;
    }
    const id = nextId++;
    const payload = { ...obj, id };
    const timer = setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        resolve({ ok: false, kind: "timeout", error: "bridge did not respond in time" });
      }
    }, timeout);
    pending.set(id, { resolve, timer });
    try {
      ws.send(JSON.stringify(payload));
    } catch (e) {
      clearTimeout(timer);
      pending.delete(id);
      resolve({ ok: false, kind: "disconnected", error: String(e) });
    }
  });
}

// Ask the bridge whether a Roblox Studio instance is actually connected to the
// MCP server. Broadcasts only on change so the UI updates promptly but quietly.
let studioProbing = false;
async function refreshStudioStatus() {
  if (studioProbing || !connected) return;
  studioProbing = true;
  try {
    const r = await send({ type: "studio_status" }, 12000);
    const v = r && r.ok && typeof r.studio === "boolean" ? r.studio : null;
    if (v !== studioConnected) {
      studioConnected = v;
      broadcastStatus();
    }
  } finally {
    studioProbing = false;
  }
}

function handleBridgeMessage(msg) {
  if ("studio" in msg && (typeof msg.studio === "boolean" || msg.studio === null)) {
    studioConnected = msg.studio;
  }
  if ("studio_app" in msg && (typeof msg.studio_app === "boolean" || msg.studio_app === null)) {
    studioApp = msg.studio_app;
  }
  if ("studio_proc" in msg && (typeof msg.studio_proc === "boolean" || msg.studio_proc === null)) {
    studioProc = msg.studio_proc;
  }
  if (msg.type === "studio_status") {
    resolvePending(msg.id, { ok: true, studio: studioConnected });
    broadcastStatus();
    return;
  }
  if (msg.type === "connected") {
    mcpAlive = !!msg.mcp_alive;
    if (Array.isArray(msg.tools)) toolsCache = msg.tools;
    if (Array.isArray(msg.servers)) serversCache = msg.servers;
    broadcastStatus();
    return;
  }
  if (msg.type === "pong") {
    resolvePending(msg.id, { ok: true });
    return;
  }
  if (msg.type === "tools") {
    if (Array.isArray(msg.tools)) toolsCache = msg.tools;
    if (Array.isArray(msg.servers)) serversCache = msg.servers;
    mcpAlive = !!msg.mcp_alive;
    resolvePending(msg.id, { ok: true, tools: toolsCache });
    broadcastStatus();
    return;
  }
  if (msg.type === "tool_result") {
    resolvePending(msg.id, msg.ok
      ? { ok: true, text: msg.text, images: msg.images || [] }
      : { ok: false, kind: msg.kind, error: msg.error });
    return;
  }
  if (msg.type === "mcp_status") {
    mcpAlive = !!msg.alive;
    if (Array.isArray(msg.tools)) toolsCache = msg.tools;
    if (Array.isArray(msg.servers)) serversCache = msg.servers;
    resolvePending(msg.id, { ok: !!msg.ok, alive: msg.alive, error: msg.error });
    broadcastStatus();
    return;
  }
  if (msg.type === "server_changed") {
    // The bridge acks, then restarts itself to reload config.json. The socket
    // will drop right after this - the content script shows a spinner until the
    // reconnect lands and a fresh status arrives.
    resolvePending(msg.id, { ok: !!msg.ok, error: msg.error, restarting: !!msg.restarting });
    return;
  }
  if (msg.type === "error") {
    resolvePending(msg.id, { ok: false, error: msg.error });
    return;
  }
}

function resolvePending(id, value) {
  const p = pending.get(id);
  if (!p) return;
  clearTimeout(p.timer);
  pending.delete(id);
  p.resolve(value);
}

function failAllPending(reason) {
  for (const [, p] of pending) {
    clearTimeout(p.timer);
    p.resolve({ ok: false, kind: "disconnected", error: reason });
  }
  pending.clear();
}

// ── status push to any open DeepSeek tab + popup ─────────────────────────
function statusObj() {
  return { type: "zs-status", connected, mcpAlive, studio: studioConnected, studioApp, studioProc, tools: toolsCache.length, servers: serversCache };
}

function broadcastStatus() {
  chrome.runtime.sendMessage(statusObj()).catch(() => {});
  chrome.tabs.query({ url: PROVIDER_URLS }, (tabs) => {
    for (const t of tabs) chrome.tabs.sendMessage(t.id, statusObj()).catch(() => {});
  });
}

// ── Ultra AI orchestration ────────────────────────────────────────────────
const ultraHealth = new Map(); // providerId -> {limitedUntil, failures, lastError, lastOk}
const ultraJobs = new Map();   // jobId -> public progress snapshot
let ultraSeq = 1;
const ULTRA_TIMEOUT = 210000;
const ULTRA_LIMIT_MS = 30 * 60 * 1000;
const ULTRA_JOB_STORE_KEY = "nqUltraJobs";
const ULTRA_JOB_STORE_MAX = 60;
let ultraJobsLoaded = false;
let ultraJobsLoadPromise = null;

async function loadUltraJobs() {
  if (ultraJobsLoaded) return;
  if (ultraJobsLoadPromise) return ultraJobsLoadPromise;
  ultraJobsLoadPromise = new Promise((resolve) => {
    chrome.storage.local.get(ULTRA_JOB_STORE_KEY, (r) => {
      const saved = Array.isArray(r?.[ULTRA_JOB_STORE_KEY]) ? r[ULTRA_JOB_STORE_KEY] : [];
      for (const job of saved) if (job?.id) ultraJobs.set(job.id, job);
      ultraJobsLoaded = true;
      resolve();
    });
  });
  return ultraJobsLoadPromise;
}

function trimUltraJob(job) {
  const out = { ...job, results: Array.isArray(job.results) ? job.results.map((r) => ({
    ...r,
    text: String(r?.text || "").slice(0, 14000),
  })) : [] };
  out.task = String(out.task || "").slice(0, 6000);
  out.final = String(out.final || "").slice(0, 24000);
  out.error = String(out.error || "").slice(0, 6000);
  return out;
}

function persistUltraJobs() {
  const list = [...ultraJobs.values()]
    .sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0))
    .slice(0, ULTRA_JOB_STORE_MAX)
    .map(trimUltraJob);
  chrome.storage.local.set({ [ULTRA_JOB_STORE_KEY]: list }, () => { void chrome.runtime.lastError; });
}

function ultraJobRecord(job) {
  return {
    ...ultraJobSnapshot(job),
    startedAt: job.startedAt || 0,
    updatedAt: job.updatedAt || Date.now(),
    stopped: !!job.stopRequested,
    activeProviderId: job.activeProviderId || "",
    activeProviderName: job.activeProviderName || "",
    activeTabId: Number.isInteger(job.activeTabId) ? job.activeTabId : null,
  };
}

function ultraFinishStopped(job, reason = "Stopped by user") {
  job.status = "stopped";
  job.stage = "stopped";
  job.error = reason;
  job.stopRequested = true;
  job.updatedAt = Date.now();
  ultraBroadcast(job);
  return ultraJobSnapshot(job);
}


function ultraProviders() {
  try { return globalThis.NQYProviderRegistry?.all?.() || []; } catch { return []; }
}
function ultraSettings() {
  return new Promise((resolve) => chrome.storage.local.get("nqSettings", (r) => resolve(r?.nqSettings || {})));
}
function ultraHealthFor(id) {
  const h = ultraHealth.get(id) || { limitedUntil: 0, failures: 0, lastError: "", lastOk: 0 };
  ultraHealth.set(id, h);
  return h;
}
function ultraMark(id, kind, error = "") {
  const h = ultraHealthFor(id);
  if (kind === "ok") { h.lastOk = Date.now(); h.failures = 0; h.lastError = ""; return; }
  h.failures += 1; h.lastError = String(error || kind);
  if (kind === "limit") h.limitedUntil = Date.now() + ULTRA_LIMIT_MS;
}
function ultraScore(p, role, settings) {
  const h = ultraHealthFor(p.id);
  if (h.limitedUntil > Date.now()) return -Infinity;
  if (Array.isArray(settings.enabledProviders) && !settings.enabledProviders.includes(p.id)) return -Infinity;
  if (p.mode === "catalog") return -Infinity;
  let score = Number(p.roleScores?.[role] || 80);
  if (p.mode === "generic") score -= 8;
  score -= Math.min(30, h.failures * 5);
  if (p.id === settings.preferredProvider) score += 3;
  return score;
}
function ultraPick(role, settings, exclude = new Set()) {
  const list = ultraProviders().filter((p) => !exclude.has(p.id));
  return list.sort((a,b) => ultraScore(b, role, settings) - ultraScore(a, role, settings))[0] || null;
}
function ultraUrl(p) { return p?.url || ""; }

async function ultraWaitForTabLoad(tabId, timeout = 30000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return; done = true; chrome.tabs.onUpdated.removeListener(onUpdated); clearTimeout(timer); resolve(true);
    };
    const onUpdated = (id, info) => { if (id === tabId && info.status === "complete") finish(); };
    const timer = setTimeout(finish, timeout);
    chrome.tabs.onUpdated.addListener(onUpdated);
  });
}

async function ultraWaitForWorker(tabId, timeout = 25000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const r = await new Promise((resolve) => {
        chrome.tabs.sendMessage(tabId, { type: "nq-ultra-state" }, (x) => {
          if (chrome.runtime.lastError) resolve(null); else resolve(x || null);
        });
      });
      if (r?.ok) return r;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  return null;
}

async function ultraEnsureTab(providerId, job = null) {
  const p = globalThis.NQYProviderRegistry?.get?.(providerId);
  if (!p || !ultraUrl(p)) throw new Error(`No chat URL configured for ${providerId}`);
  const tabs = await chrome.tabs.query({});
  const hostSet = new Set(p.hosts || []);
  let tab = tabs.find((t) => {
    try { return !t.active && hostSet.has(new URL(t.url || "").hostname) && t.id !== job?.activeTabId; } catch { return false; }
  });
  if (!tab) tab = await chrome.tabs.create({ url: ultraUrl(p), active: false });

  // Ultra workers always get a clean conversation so the normal bot bootstrap
  // can run BEFORE the actual worker prompt. This prevents a stale chat/session
  // from receiving an Ultra task without the agent being started first.
  try {
    const loadWait = ultraWaitForTabLoad(tab.id, 30000);
    await chrome.tabs.update(tab.id, { url: ultraUrl(p), active: false });
    await loadWait;
  } catch {}
  let state = await ultraWaitForWorker(tab.id, 30000);
  if (!state?.ok) {
    try { await chrome.tabs.reload(tab.id); } catch {}
    state = await ultraWaitForWorker(tab.id, 30000);
  }
  if (job) {
    job.activeTabId = tab.id;
    job.activeProviderId = providerId;
    job.activeProviderName = p.name;
    job.updatedAt = Date.now();
    ultraBroadcast(job);
  }
  return { tab, state };
}

async function ultraAskProvider(providerId, prompt, options = {}) {
  const job = options.job || null;
  const { tab, state } = await ultraEnsureTab(providerId, job);
  if (!state?.ok) throw new Error(`${providerId} did not load the 5nqy_devbot worker.`);
  if (job?.stopRequested) return { ok: false, kind: "stopped", error: "Stopped by user.", providerId, providerName: state.name || providerId };
  if (!state.loggedIn) {
    ultraMark(providerId, "offline", "Not logged in");
    const e = new Error(`${state.name || providerId} is not logged in.`); e.code = "NOT_LOGGED_IN"; throw e;
  }
  if (state.limited) {
    ultraMark(providerId, "limit", state.limitDetail);
    const e = new Error(state.limitDetail || `${state.name || providerId} reports a limit.`); e.code = "LIMIT"; throw e;
  }

  // The critical ordering fix: bootstrap the actual 5nqy_devbot session first.
  // Only after start has completed do we pass the task prompt to the AI.
  if (!state.started) {
    if (job) { job.stage = `starting ${state.name || providerId} agent`; job.updatedAt = Date.now(); ultraBroadcast(job); }
    const started = await new Promise((resolve) => {
      chrome.tabs.sendMessage(tab.id, { type: "nq-ultra-start", options: { forceNew: true } }, (r) => {
        if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
        else resolve(r || { ok: false, error: "No start response." });
      });
    });
    if (!started?.ok) {
      return { ok: false, kind: started?.kind || "start_failed", error: started?.error || "Could not start the 5nqy_devbot agent before the prompt.", providerId, providerName: state.name || providerId };
    }
  }
  if (job) { job.stage = options.stage || job.stage; job.updatedAt = Date.now(); ultraBroadcast(job); }

  const result = await new Promise((resolve) => {
    let done = false;
    const finish = (value) => { if (done) return; done = true; clearTimeout(timer); resolve(value); };
    const timer = setTimeout(() => finish({ ok: false, kind: "timeout", error: "Provider timed out." }), options.timeout || ULTRA_TIMEOUT);
    chrome.tabs.sendMessage(tab.id, { type: "nq-ultra-ask", prompt, options: { executeTools: !!options.executeTools, requireVisible: false } }, (r) => {
      if (chrome.runtime.lastError) finish({ ok: false, kind: "transport", error: chrome.runtime.lastError.message });
      else finish(r || { ok: false, kind: "empty", error: "No provider response." });
    });
  });
  if (result.ok) ultraMark(providerId, "ok");
  else if (result.kind === "context_limit" || /limit|quota|rate/i.test(`${result.error || ""} ${result.detail || ""}`)) ultraMark(providerId, "limit", result.error || result.detail);
  else ultraMark(providerId, result.kind === "stopped" ? "failure" : "failure", result.error || result.kind);
  return { ...result, providerId, providerName: state.name || providerId };
}

function ultraJobSnapshot(job) {
  return {
    id: job.id, mode: job.mode, task: job.task, status: job.status, stage: job.stage,
    completed: job.completed, total: job.total, results: job.results, final: job.final || "",
    error: job.error || "", startedAt: job.startedAt || 0, updatedAt: job.updatedAt || Date.now(),
    stopped: !!job.stopRequested, activeProviderId: job.activeProviderId || "",
    activeProviderName: job.activeProviderName || "", activeTabId: Number.isInteger(job.activeTabId) ? job.activeTabId : null,
  };
}
function ultraBroadcast(job) {
  job.updatedAt = Date.now();
  const snap = ultraJobSnapshot(job);
  // Keep the live job object in memory so Stop can signal the currently running
  // orchestration, while storage receives only the serialisable snapshot.
  ultraJobs.set(job.id, job);
  persistUltraJobs();
  try { chrome.runtime.sendMessage({ type: "nq-ultra-progress", job: snap }).catch(() => {}); } catch {}
}

function ultraWorkerPrompt(task, role, index, total) {
  const roleText = {
    planner: "Act as the architecture/planning specialist. Produce a concrete implementation plan, dependencies, edge cases and verification checklist. Do not pretend you inspected files you cannot access.",
    coder: "Act as the primary coding specialist. Propose precise code changes, algorithms, data structures and failure handling. Prefer production-ready, maintainable solutions.",
    roblox: "Act as a Roblox/Luau specialist. Focus on Roblox Studio, ServerScriptService, ModuleScripts, DataStores, remotes, replication, lifecycle, performance and Luau correctness.",
    qa: "Act as a hostile QA/debugging specialist. Identify likely compile/runtime errors, race conditions, API misuse, nil paths, type issues and test cases. Give exact fixes.",
    reviewer: "Act as a senior reviewer. Compare likely implementation approaches, identify hidden risks and state what a final implementation must verify.",
    threeD: "Act as a Roblox 3D/game-systems specialist. Focus on spatial logic, assets, UI/UX, performance and integration boundaries where relevant."
  }[role] || "Act as a senior software engineer.";
  return `You are one independent worker inside 5nqy_devbot Ultra AI.\n\nTASK:\n${task}\n\nROLE:\n${roleText}\n\nThis is worker ${index + 1} of ${total}. Give an independent technical proposal for a later judge. Do not claim a change was made unless you actually made it. Keep the output structured with: findings, proposed solution, exact risks, and verification steps.`;
}

async function runUltraJob(task, options = {}) {
  const settings = await ultraSettings();
  const rounds = Math.max(2, Math.min(7, Number(options.rounds || settings.ultraAiRounds || 5)));
  const roles = Array.isArray(settings.ultraAiRoles) && settings.ultraAiRoles.length ? settings.ultraAiRoles : ["planner", "coder", "roblox", "qa", "reviewer"];
  const job = { id: options.jobId || `ultra-${Date.now()}-${ultraSeq++}`, mode: "ultra", task: String(task).trim(), status: "running", stage: "planning", completed: 0, total: rounds + 2, results: [], startedAt: Date.now(), updatedAt: Date.now(), stopRequested: false, activeProviderId: "", activeProviderName: "", activeTabId: null };
  ultraBroadcast(job);
  try {
    const used = new Set();
    for (let i = 0; i < rounds; i++) {
      let role = roles[i % roles.length];
      if (/\b(3d|model|terrain|mesh|asset|map|ui|interface|animation|building|environment)\b/i.test(job.task) && i === Math.min(3, rounds - 1)) role = "threeD";
      let p = ultraPick(role, settings, used);
      if (!p) p = ultraPick(role, settings, new Set());
      if (!p) throw new Error("No enabled AI provider is currently available.");
      used.add(p.id);
      if (job.stopRequested) return ultraFinishStopped(job);
      job.stage = `worker ${i + 1}/${rounds} · ${p.name}`; ultraBroadcast(job);
      let result;
      try { result = await ultraAskProvider(p.id, ultraWorkerPrompt(job.task, role, i, rounds), { timeout: 180000, job, stage: job.stage }); }
      catch (e) { result = { ok: false, error: e.message, kind: e.code || "failure", providerId: p.id, providerName: p.name }; }
      if (job.stopRequested || result.kind === "stopped") return ultraFinishStopped(job);
      if (!result.ok && (result.kind === "LIMIT" || result.kind === "NOT_LOGGED_IN" || /limit|quota|rate|logged in/i.test(result.error || ""))) {
        const alt = ultraPick(role, settings, new Set([p.id]));
        if (alt && !job.stopRequested) { try { result = await ultraAskProvider(alt.id, ultraWorkerPrompt(job.task, role, i, rounds), { timeout: 180000, job, stage: job.stage }); } catch (e) { result = { ok:false, error:e.message, kind:e.code || "failure", providerId:alt.id, providerName:alt.name }; } }
      }
      if (job.stopRequested || result.kind === "stopped") return ultraFinishStopped(job);
      job.results.push({ role, provider: result.providerName || p.name, ok: !!result.ok, text: String(result.text || result.raw || result.error || "") });
      job.completed++; ultraBroadcast(job);
    }

    if (job.stopRequested) return ultraFinishStopped(job);
    job.stage = "judge"; ultraBroadcast(job);
    const evidence = job.results.map((r, i) => `--- WORKER ${i + 1} · ${r.role} · ${r.provider} · ${r.ok ? "OK" : "FAILED"} ---\n${r.text}`).join("\n\n");
    const judgeProvider = ultraPick("reviewer", settings) || ultraPick("coder", settings);
    if (!judgeProvider) throw new Error("No reviewer provider is available.");
    const judgePrompt = `You are the lead judge for 5nqy_devbot Ultra AI.\n\nORIGINAL TASK:\n${job.task}\n\nINDEPENDENT WORKER REPORTS:\n${evidence}\n\nSynthesize the reports into one implementation blueprint. Resolve disagreements using technical reasoning. Explicitly list the exact files/Roblox paths to inspect, the safest order of operations, tests that prove the fix, and any claims that still need live verification. Do not invent tool output.`;
    let judge;
    try { judge = await ultraAskProvider(judgeProvider.id, judgePrompt, { timeout: 180000, job, stage: "judge" }); }
    catch (e) { judge = { ok:false, error:e.message, providerName:judgeProvider.name }; }
    if (job.stopRequested || judge.kind === "stopped") return ultraFinishStopped(job);
    job.results.push({ role: "judge", provider: judge.providerName || judgeProvider.name, ok: !!judge.ok, text: String(judge.text || judge.raw || judge.error || "") });
    job.completed++; ultraBroadcast(job);

    if (job.stopRequested) return ultraFinishStopped(job);
    job.stage = "builder"; ultraBroadcast(job);
    const builderRole = /roblox|luau|studio|ServerScriptService|ModuleScript/i.test(job.task) ? "roblox" : "coder";
    let builder = ultraPick(builderRole, settings);
    if (!builder) builder = ultraPick("coder", settings);
    if (!builder) throw new Error("No builder provider is available.");
    const buildPrompt = `You are the FINAL BUILDER inside 5nqy_devbot Ultra AI.\n\nORIGINAL USER TASK:\n${job.task}\n\nLEAD JUDGE BLUEPRINT:\n${String(judge?.text || judge?.raw || judge?.error || "No judge output")}\n\nWORKER EVIDENCE:\n${evidence}\n\nNow perform the task for real. If this is a Roblox task, use the connected Roblox Studio tools to inspect the exact current state before editing. For game.ServerScriptService.Services.DataService, read the actual script/module and its dependencies first, then fix every compile/runtime issue you can verify. Do not fabricate success. Iterate: inspect -> edit -> run/verify -> re-read -> fix remaining errors. Finish only when the available tooling shows the cleanest verified state possible. Report exactly what you changed and what verification produced.`;
    let build;
    try { build = await ultraAskProvider(builder.id, buildPrompt, { executeTools: true, timeout: 360000, job, stage: "builder" }); }
    catch (e) { build = { ok:false, error:e.message, providerName:builder.name }; }
    if (job.stopRequested || build.kind === "stopped") return ultraFinishStopped(job);
    job.results.push({ role: "builder", provider: build.providerName || builder.name, ok: !!build.ok, text: String(build.text || build.raw || build.error || "") });
    job.completed++; job.stage = build.ok ? "complete" : "builder failed"; job.status = build.ok ? "complete" : "error"; job.final = String(build.text || build.raw || build.error || ""); ultraBroadcast(job);
    return ultraJobSnapshot(job);
  } catch (e) {
    job.status = "error"; job.stage = "failed"; job.error = String(e?.message || e); ultraBroadcast(job); return ultraJobSnapshot(job);
  }
}

// ── messages from content.js / popup.js ─────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    switch (msg.type) {
      case "ultra_start": {
        await loadUltraJobs();
        const task = String(msg.task || "").trim();
        if (!task) { sendResponse({ ok: false, error: "Enter a task for Ultra AI." }); break; }
        const jobId = `ultra-${Date.now()}-${ultraSeq++}`;
        // Return immediately; progress is broadcast to the popup/options UI.
        runUltraJob(task, { rounds: msg.rounds, jobId }).catch((e) => console.error("[5nqy_devbot] Ultra AI job", e));
        sendResponse({ ok: true, started: true, jobId });
        break;
      }
      case "ultra_status": {
        await loadUltraJobs();
        const job = ultraJobs.get(msg.jobId);
        sendResponse(job ? ultraJobSnapshot(job) : { ok: false, error: "Ultra AI job not found." });
        break;
      }
      case "ultra_list": {
        await loadUltraJobs();
        sendResponse({ ok: true, jobs: [...ultraJobs.values()].map(ultraJobSnapshot).sort((a,b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0)) });
        break;
      }
      case "ultra_stop": {
        await loadUltraJobs();
        const job = ultraJobs.get(msg.jobId);
        if (!job) { sendResponse({ ok: false, error: "Ultra AI job not found." }); break; }
        job.stopRequested = true;
        job.stopped = true;
        if (Number.isInteger(job.activeTabId)) {
          chrome.tabs.sendMessage(job.activeTabId, { type: "nq-ultra-stop" }, () => { void chrome.runtime.lastError; });
        }
        if (job.status === "running") ultraFinishStopped(job);
        sendResponse({ ok: true, jobId: job.id, status: job.status });
        break;
      }
      case "ultra_stop_all": {
        await loadUltraJobs();
        let count = 0;
        for (const job of ultraJobs.values()) {
          if (job.status === "running") {
            job.stopRequested = true;
            job.stopped = true;
            if (Number.isInteger(job.activeTabId)) chrome.tabs.sendMessage(job.activeTabId, { type: "nq-ultra-stop" }, () => { void chrome.runtime.lastError; });
            ultraFinishStopped(job);
            count++;
          }
        }
        sendResponse({ ok: true, count });
        break;
      }
      case "ultra_open_job": {
        await loadUltraJobs();
        const job = ultraJobs.get(msg.jobId);
        if (!job || !Number.isInteger(job.activeTabId)) { sendResponse({ ok: false, error: "No AI chat tab is saved for this run." }); break; }
        try { await chrome.tabs.update(job.activeTabId, { active: true }); sendResponse({ ok: true }); }
        catch (e) { sendResponse({ ok: false, error: String(e?.message || e) }); }
        break;
      }
      case "ultra_provider_status": {
        const out = [];
        for (const p of ultraProviders()) {
          const h = ultraHealthFor(p.id);
          out.push({ id: p.id, name: p.name, mode: p.mode, limitedUntil: h.limitedUntil, failures: h.failures, lastError: h.lastError, score: ultraScore(p, "coder", await ultraSettings()) });
        }
        sendResponse({ ok: true, providers: out });
        break;
      }
      case "status":
        if (!connected) connect(); // self-heal after a worker wake-up
        sendResponse(statusObj());
        break;
      case "list_tools": {
        // Prefer a live refresh; fall back to cache so the loop never stalls.
        // 10s, not 25s: a catalogue request only blocks this long when one of the
        // MCP servers is dead (typically Roblox in a degraded, Blender-only
        // session), and in that exact case we already hold a perfectly good cached
        // catalogue. Waiting the full 25s just froze the boot for no new data.
        const r = await send({ type: "list_tools" }, 10000);
        if (r.ok) sendResponse({ ok: true, tools: r.tools });
        else sendResponse({ ok: toolsCache.length > 0, tools: toolsCache, error: r.error });
        break;
      }
      case "call_tool": {
        const timeout = (msg.timeout || 120000) + 10000;
        const r = await send(
          { type: "call_tool", name: msg.name, arguments: msg.arguments, timeout: msg.timeout },
          timeout
        );
        sendResponse(r);
        break;
      }
      case "restart_mcp": {
        const r = await send({ type: "restart_mcp" }, 30000);
        sendResponse(r);
        break;
      }
      case "add_server": {
        const r = await send({
          type: "add_server", server_id: msg.server_id,
          command: msg.command, args: msg.args, env: msg.env,
        }, 15000);
        sendResponse(r);
        break;
      }
      case "remove_server": {
        const r = await send({ type: "remove_server", server_id: msg.server_id }, 15000);
        sendResponse(r);
        break;
      }
      case "reconnect":
        reconnectDelay = RECONNECT_MIN;
        connect();
        sendResponse({ ok: true });
        break;
      default:
        sendResponse({ ok: false, error: "unknown message" });
    }
  })();
  return true; // async sendResponse
});

// Wake/keepalive hooks.
chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);

connect();


// Browser command: toggle the current supported provider panel.
chrome.commands?.onCommand?.addListener(async (command) => {
  if (command !== "toggle-panel") return;
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tab = tabs[0];
    if (tab?.id != null) chrome.tabs.sendMessage(tab.id, { type: "nq-toggle-panel" }).catch(() => {});
  } catch {}
});
