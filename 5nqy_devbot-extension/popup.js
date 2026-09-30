// SPDX-License-Identifier: GPL-3.0-or-later
const KOFI_URL = "https://ko-fi.com/sebattfg";
const $ = (id) => document.getElementById(id);
const state = { activeJob: null, jobs: [], historyTimer: null, pollTimer: null, currentTab: "run" };

$("ver").textContent = `v${chrome.runtime.getManifest().version}`;

function send(msg) {
  return new Promise((resolve) => chrome.runtime.sendMessage(msg, (res) => resolve(res)));
}
function timeText(ts) {
  if (!ts) return "";
  const d = new Date(ts); return d.toLocaleString();
}
function statusLabel(status) {
  return String(status || "running").toUpperCase();
}
function render(s = {}) {
  const dot = $("dot"), stateEl = $("state"), tools = $("tools"), servers = $("servers");
  const list = s.servers || []; const up = list.filter((x) => x.alive).length;
  const ready = !!s.connected && (s.studio !== false) && (s.mcpAlive || up > 0 || s.tools > 0);
  dot.className = "dot " + (ready ? "on" : s.connected ? "warn" : "");
  stateEl.textContent = ready ? "Bridge connected · Studio ready" : s.connected ? "Bridge connected · Studio needs attention" : "Bridge offline · start the local bridge";
  tools.textContent = s.connected ? `${s.tools || 0} tools available` : "Local bridge is not connected";
  servers.textContent = s.connected ? list.map((x) => `${x.alive ? "●" : "○"} ${x.id} · ${x.alive ? `${x.tools} tools` : "offline"}`).join("\n") : "";
}
function refresh(){ send({type:"status"}).then((s)=>{if(s)render(s);}); }

function ultraProgress(job){
  if (!job) return;
  state.activeJob = job.id;
  const p=$("progress"), r=$("result"), pill=$("ultra-pill");
  pill.textContent=statusLabel(job.status);
  p.textContent=`${job.stage||"Working…"} · ${job.completed||0}/${job.total||0}${job.activeProviderName ? ` · ${job.activeProviderName}` : ""}`;
  if(job.status==="complete"||job.status==="error"||job.status==="stopped"){
    r.hidden=false;
    r.textContent=job.final||job.error||job.results?.map(x=>`${x.role} · ${x.provider}\n${x.text}`).join("\n\n")||"No final report.";
    pill.textContent=statusLabel(job.status);
  }
  mergeJob(job);
}
function mergeJob(job) {
  const idx = state.jobs.findIndex((x) => x.id === job.id);
  if (idx >= 0) state.jobs[idx] = job; else state.jobs.push(job);
  state.jobs.sort((a,b)=>Number(b.updatedAt||0)-Number(a.updatedAt||0));
  renderJobs();
}

async function startUltra(){
  const task=$("task").value.trim(), rounds=Number($("rounds").value);
  if(!task){$("progress").textContent="Enter a task first.";return;}
  const b=$("run-ultra"); b.disabled=true; b.textContent="Starting agent teams…";
  $("result").hidden=true;
  const res=await send({type:"ultra_start",task,rounds});
  if(!res?.ok){$("progress").textContent=res?.error||"Ultra AI could not start.";b.disabled=false;b.textContent="Run Ultra AI";return;}
  state.activeJob=res.jobId; $("progress").textContent="Saved. Starting each bot before its AI receives the task…";
  if (state.pollTimer) clearInterval(state.pollTimer);
  state.pollTimer=setInterval(async()=>{
    if(!state.activeJob)return;
    const j=await send({type:"ultra_status",jobId:state.activeJob});
    if(j && j.id){ ultraProgress(j); if(["complete","error","stopped"].includes(j.status)){clearInterval(state.pollTimer);state.pollTimer=null;b.disabled=false;b.textContent="Run Ultra AI";} }
  },1000);
  await loadJobs();
}

function escapeHtml(text){return String(text??"").replace(/[&<>"']/g,(m)=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[m]));}
function renderJobs(){
  const box=$("jobs"); $("chat-count").textContent=String(state.jobs.length);
  if(!state.jobs.length){box.innerHTML='<div class="empty">No saved chats yet. Start an Ultra AI run and it will stay here after you close the popup.</div>';return;}
  box.innerHTML=state.jobs.map((job)=>{
    const total=Math.max(1,Number(job.total||0)), done=Math.min(total,Number(job.completed||0));
    const pct=Math.round(done/total*100);
    const canStop=job.status==="running";
    const detail = job.final || job.error || (job.results||[]).map((r)=>`${r.role} · ${r.provider}\n${r.text}`).join("\n\n") || "No report yet.";
    return `<div class="job-card" data-job="${escapeHtml(job.id)}">
      <div class="job-top"><div class="job-main"><div class="job-title">${escapeHtml(job.task)}</div><div class="job-meta">${statusLabel(job.status)} · ${escapeHtml(job.activeProviderName||"AI team")} · ${escapeHtml(timeText(job.updatedAt||job.startedAt))}</div></div></div>
      <div class="job-stage">${escapeHtml(job.stage||"Working…")} · ${done}/${total}</div><div class="job-bar"><div class="job-fill" style="width:${pct}%"></div></div>
      <div class="job-actions"><button class="open-job">Open saved chat</button>${canStop?'<button class="mini-stop">■ Stop</button>':''}${Number.isInteger(job.activeTabId)?'<button class="open-ai">Open AI tab</button>':''}</div>
      <div class="detail job-detail" hidden>${escapeHtml(detail)}</div>
    </div>`;
  }).join("");
  box.querySelectorAll(".job-card").forEach((card)=>{
    const id=card.dataset.job, job=state.jobs.find((x)=>x.id===id);
    card.querySelector(".open-job")?.addEventListener("click",()=>{
      const d=card.querySelector(".job-detail"); if(d)d.hidden=!d.hidden;
      state.activeJob=id; $("run-tab").click(); ultraProgress(job); $("task").value=job?.task||"";
    });
    card.querySelector(".mini-stop")?.addEventListener("click",async(e)=>{e.currentTarget.disabled=true;await send({type:"ultra_stop",jobId:id});await loadJobs();});
    card.querySelector(".open-ai")?.addEventListener("click",async(e)=>{e.currentTarget.disabled=true;const r=await send({type:"ultra_open_job",jobId:id});if(!r?.ok)alert(r?.error||"Could not open the saved AI tab.");e.currentTarget.disabled=false;});
  });
}
async function loadJobs(){
  const r=await send({type:"ultra_list"});
  if(!r?.ok)return;
  state.jobs=r.jobs||[]; renderJobs();
  const running=state.jobs.find((j)=>j.status==="running");
  if(running && !state.activeJob) state.activeJob=running.id;
  if(running) ultraProgress(running);
  if(state.jobs.some((j)=>j.status==="running") && !state.historyTimer){
    state.historyTimer=setInterval(loadJobs,1600);
  } else if(!state.jobs.some((j)=>j.status==="running") && state.historyTimer){
    clearInterval(state.historyTimer);state.historyTimer=null;
  }
}

$("run-ultra").onclick=startUltra;
$("fix-data").onclick=()=>{
  $("task").value="Fix game.ServerScriptService.Services.DataService completely. Inspect the real Roblox Studio script and every dependency it uses. Find and fix all compile errors, runtime errors, nil/indexing issues, type/API mistakes, DataStore lifecycle problems, race conditions and integration issues you can actually verify. Do not guess. Re-read the final files and run the safest available verification/tests until there are 0 verified errors. Preserve intended behaviour. Report every change and the verification result.";
  $("rounds").value="5"; startUltra();
};
$("reconnect").onclick=()=>send({type:"reconnect"}).then(()=>setTimeout(refresh,500));
$("restart").onclick=async(e)=>{e.target.textContent="Restarting…";await send({type:"restart_mcp"});e.target.textContent="Restart Studio bridge";setTimeout(refresh,600);};
$("settings").onclick=()=>chrome.runtime.openOptionsPage();
$("support").onclick=()=>chrome.tabs.create({url:KOFI_URL});
$("stop-all").onclick=async(e)=>{e.currentTarget.disabled=true;await send({type:"ultra_stop_all"});await loadJobs();e.currentTarget.disabled=false;};
$("refresh-chats").onclick=loadJobs;
$("run-tab").onclick=()=>{state.currentTab="run";$("run-tab").classList.add("active");$("chats-tab").classList.remove("active");$("run-panel").classList.add("active");$("chats-panel").classList.remove("active");};
$("chats-tab").onclick=()=>{state.currentTab="chats";$("chats-tab").classList.add("active");$("run-tab").classList.remove("active");$("chats-panel").classList.add("active");$("run-panel").classList.remove("active");loadJobs();};
chrome.runtime.onMessage.addListener((m)=>{if(m?.type==="zs-status")render(m);if(m?.type==="nq-ultra-progress")ultraProgress(m.job);});

refresh();
loadJobs();
