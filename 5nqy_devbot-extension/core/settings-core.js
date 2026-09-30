// Shared 5nqy_devbot settings schema.
const NQY_SETTINGS = (() => {
  "use strict";
  const DEFAULTS = Object.freeze({
    enabledProviders: null,
    preferredProvider: "deepseek",
    preferredModel: "",
    theme: "dark",
    notifications: true,
    keyboardShortcuts: true,
    automationEnabled: true,
    autoResume: true,
    compactMode: false,
    experimentalProviders: true,
    showProviderBadges: true,
    customPrompts: {},
    ultraAiEnabled: true,
    ultraAiRounds: 5,
    ultraAiStrategy: "auto",
    autoSwapEnabled: true,
    autoSwapOnLimit: true,
    autoSwapOnOffline: true,
    autoSwapCooldownMinutes: 30,
    ultraAiRoles: ["planner", "coder", "roblox", "qa", "reviewer"],
  });
  function normalize(value) {
    const out = { ...DEFAULTS, ...(value || {}) };
    if (!Array.isArray(out.enabledProviders)) out.enabledProviders = null;
    if (!out.customPrompts || typeof out.customPrompts !== "object") out.customPrompts = {};
    return out;
  }
  function get() {
    return new Promise((resolve) => chrome.storage.local.get("nqSettings", (r) => resolve(normalize(r.nqSettings))));
  }
  function set(patch) {
    return get().then((current) => new Promise((resolve) => {
      const next = normalize({ ...current, ...patch });
      chrome.storage.local.set({ nqSettings: next }, () => resolve(next));
    }));
  }
  return Object.freeze({ DEFAULTS, normalize, get, set });
})();
