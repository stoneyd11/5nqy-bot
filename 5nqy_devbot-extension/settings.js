// SPDX-License-Identifier: GPL-3.0-or-later
(() => {
  "use strict";
  const registry = globalThis.NQYProviderRegistry || { all: () => [] };
  const $ = (id) => document.getElementById(id);
  const status = $("save-state");
  let state;

  function showSection(id) {
    document.querySelectorAll(".nav").forEach((b) => b.classList.toggle("active", b.dataset.section === id));
    document.querySelectorAll(".section").forEach((s) => s.classList.toggle("active", s.id === id));
  }
  document.querySelectorAll(".nav").forEach((b) => b.addEventListener("click", () => showSection(b.dataset.section)));

  function setStatus(text) { status.textContent = text; }
  let saveTimer;
  async function save(patch) {
    state = await NQY_SETTINGS.set(patch);
    setStatus("Saved");
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => setStatus("All changes saved"), 900);
  }

  function fillProviderSelect() {
    const el = $("preferredProvider");
    el.innerHTML = "";
    for (const p of registry.all()) {
      if (p.mode === "catalog") continue;
      const o = document.createElement("option"); o.value = p.id; o.textContent = `${p.name} · ${p.mode === "native" ? "native" : "compatibility"}`; el.appendChild(o);
    }
  }
  function renderProviders() {
    const list = $("provider-list");
    list.replaceChildren();
    for (const p of registry.all()) {
      const row = document.createElement("div"); row.className = "provider";
      const icon = document.createElement("div"); icon.className = "provider-icon"; icon.textContent = p.name.slice(0,1).toUpperCase();
      const body = document.createElement("div"); body.innerHTML = `<b></b><div class="muted"></div>`;
      body.querySelector("b").textContent = p.name;
      body.querySelector(".muted").textContent = p.note || "Provider-specific adapter.";
      const actions = document.createElement("div"); actions.className = "provider-actions";
      const badge = document.createElement("span"); badge.className = "badge"; badge.textContent = p.mode === "native" ? "Native adapter" : p.mode === "generic" ? "Compatibility adapter" : "Model catalog";
      const toggle = document.createElement("input"); toggle.type = "checkbox"; toggle.className = "provider-toggle"; toggle.dataset.id = p.id;
      const enabled = !state || !Array.isArray(state.enabledProviders) || state.enabledProviders.includes(p.id);
      toggle.checked = enabled; toggle.title = enabled ? "Provider enabled" : "Provider disabled";
      toggle.addEventListener("change", async () => {
        const ids = new Set(Array.isArray(state.enabledProviders) ? state.enabledProviders : registry.all().map((x) => x.id));
        if (toggle.checked) ids.add(p.id); else ids.delete(p.id);
        state = await save({ enabledProviders: [...ids] });
        toggle.title = toggle.checked ? "Provider enabled" : "Provider disabled";
      });
      actions.append(badge, toggle);
      row.append(icon, body, actions); list.appendChild(row);
    }
  }
  async function init() {
    state = await NQY_SETTINGS.get(); fillProviderSelect(); renderProviders();
    $("preferredProvider").value = state.preferredProvider;
    $("preferredModel").value = state.preferredModel;
    $("theme").value = state.theme; document.documentElement.dataset.theme = state.theme;
    $("notifications").checked = !!state.notifications;
    $("showProviderBadges").checked = !!state.showProviderBadges;
    $("compactMode").checked = !!state.compactMode;
    $("automationEnabled").checked = !!state.automationEnabled;
    $("autoResume").checked = !!state.autoResume;
    $("experimentalProviders").checked = !!state.experimentalProviders;
    $("ultraAiEnabled").checked = state.ultraAiEnabled !== false;
    $("ultraAiRounds").value = String(state.ultraAiRounds || 5);
    $("ultraAiStrategy").value = state.ultraAiStrategy || "auto";
    $("autoSwapEnabled").checked = state.autoSwapEnabled !== false;
    $("autoSwapOnLimit").checked = state.autoSwapOnLimit !== false;
    $("autoSwapOnOffline").checked = state.autoSwapOnOffline !== false;
    $("version").textContent = chrome.runtime.getManifest().version;

    $("preferredProvider").addEventListener("change", (e) => save({ preferredProvider: e.target.value }));
    $("preferredModel").addEventListener("change", (e) => save({ preferredModel: e.target.value.trim() }));
    $("theme").addEventListener("change", (e) => { document.documentElement.dataset.theme = e.target.value; save({ theme: e.target.value }); });
    $("notifications").addEventListener("change", (e) => save({ notifications: e.target.checked }));
    $("showProviderBadges").addEventListener("change", (e) => save({ showProviderBadges: e.target.checked }));
    $("compactMode").addEventListener("change", (e) => save({ compactMode: e.target.checked }));
    $("automationEnabled").addEventListener("change", (e) => save({ automationEnabled: e.target.checked }));
    $("autoResume").addEventListener("change", (e) => save({ autoResume: e.target.checked }));
    $("experimentalProviders").addEventListener("change", (e) => save({ experimentalProviders: e.target.checked }));
    $("ultraAiEnabled").addEventListener("change", (e) => save({ ultraAiEnabled: e.target.checked }));
    $("ultraAiRounds").addEventListener("change", (e) => save({ ultraAiRounds: Number(e.target.value) }));
    $("ultraAiStrategy").addEventListener("change", (e) => save({ ultraAiStrategy: e.target.value }));
    $("autoSwapEnabled").addEventListener("change", (e) => save({ autoSwapEnabled: e.target.checked }));
    $("autoSwapOnLimit").addEventListener("change", (e) => save({ autoSwapOnLimit: e.target.checked }));
    $("autoSwapOnOffline").addEventListener("change", (e) => save({ autoSwapOnOffline: e.target.checked }));
    $("reset").addEventListener("click", async () => { await chrome.storage.local.set({ nqSettings: NQY_SETTINGS.DEFAULTS }); await init(); setStatus("Settings reset"); });
  }
  init();
})();
