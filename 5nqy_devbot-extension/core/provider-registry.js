// SPDX-License-Identifier: GPL-3.0-or-later
// Provider registry and adapter metadata for 5nqy_devbot.
// Native adapters remain isolated in providers/*.js. Generic adapters use
// conservative DOM heuristics and automatically fall back to manual mode when
// a site cannot be safely automated.
(() => {
  "use strict";
  const providers = [
    {
      id: "claude", name: "Claude", url: "https://claude.ai/", mode: "native",
      hosts: ["claude.ai"], capabilities: { code: true, files: false, vision: false, roblox: true }, roleScores: { coder: 98, roblox: 97, planner: 92, qa: 94, reviewer: 96, threeD: 78 }
    },
    {
      id: "chatgpt", name: "ChatGPT", url: "https://chatgpt.com/", mode: "native",
      hosts: ["chatgpt.com", "chat.openai.com"], capabilities: { code: true, files: true, vision: false, roblox: true }, roleScores: { coder: 96, roblox: 94, planner: 95, qa: 93, reviewer: 95, threeD: 82 }
    },
    {
      id: "deepseek", name: "DeepSeek", url: "https://chat.deepseek.com/", mode: "native",
      hosts: ["chat.deepseek.com", "deepseek.com"], capabilities: { code: true, files: true, vision: true, roblox: true }, roleScores: { coder: 95, roblox: 96, planner: 93, qa: 94, reviewer: 94, threeD: 96 }
    },
    {
      id: "gemini", name: "Gemini", url: "https://gemini.google.com/app", mode: "native",
      hosts: ["gemini.google.com"], capabilities: { code: true, files: true, vision: true, roblox: true }
    },
    {
      id: "kimi", name: "Kimi", url: "https://www.kimi.com/", mode: "native",
      hosts: ["kimi.com", "www.kimi.com", "kimi.ai", "www.kimi.ai"], capabilities: { code: true, files: true, vision: true, roblox: true }
    },
    {
      id: "glm", name: "GLM / Z.ai", url: "https://chat.z.ai/", mode: "native",
      hosts: ["chat.z.ai"], capabilities: { code: true, files: true, vision: true, roblox: true }
    },
    {
      id: "qwen", name: "Qwen", url: "https://chat.qwen.ai/", mode: "native",
      hosts: ["chat.qwen.ai"], capabilities: { code: true, files: true, vision: true, roblox: true }
    },
    {
      id: "arena", name: "Arena", url: "https://arena.ai/text/direct", mode: "native",
      hosts: ["arena.ai"], capabilities: { code: true, files: false, vision: false, roblox: true }, note: "Direct text mode is the automation path."
    },
    {
      id: "meta", name: "Meta AI", url: "https://www.meta.ai/", mode: "native",
      hosts: ["meta.ai", "www.meta.ai"], capabilities: { code: true, files: true, vision: true, roblox: true }
    },

    // Generic compatibility adapters. These are deliberately marked so the UI
    // never implies that a site-specific DOM integration has been tested.
    {
      id: "mistral", name: "Mistral Vibe", url: "https://chat.mistral.ai/", mode: "generic",
      hosts: ["chat.mistral.ai"], capabilities: { code: true, files: true, vision: true, roblox: true },
      note: "Generic adapter; Vibe's UI can change without notice."
    },
    {
      id: "grok", name: "Grok", url: "https://grok.com/", mode: "generic",
      hosts: ["grok.com"], capabilities: { code: true, files: true, vision: true, roblox: true },
      note: "Generic adapter; site-specific selectors may need tuning."
    },
    {
      id: "perplexity", name: "Perplexity", url: "https://www.perplexity.ai/", mode: "generic",
      hosts: ["perplexity.ai", "www.perplexity.ai"], capabilities: { code: true, files: true, vision: true, roblox: true },
      note: "Generic adapter; automation is best-effort."
    },
    {
      id: "copilot", name: "Microsoft Copilot", url: "https://copilot.microsoft.com/", mode: "generic",
      hosts: ["copilot.microsoft.com"], capabilities: { code: true, files: true, vision: true, roblox: true },
      note: "Generic adapter; account/region variants can affect the DOM."
    },
    {
      id: "poe", name: "Poe", url: "https://poe.com/", mode: "generic",
      hosts: ["poe.com"], capabilities: { code: true, files: true, vision: true, roblox: true },
      note: "Generic adapter; individual bots can render different composers."
    },
    {
      id: "huggingface", name: "HuggingChat", url: "https://huggingface.co/chat/", mode: "generic",
      hosts: ["huggingface.co"], capabilities: { code: true, files: true, vision: true, roblox: true },
      note: "Generic adapter; model selection can change the reply surface."
    },
    {
      id: "openrouter", name: "OpenRouter", url: "https://openrouter.ai/chat", mode: "generic",
      hosts: ["openrouter.ai"], capabilities: { code: true, files: true, vision: true, roblox: true },
      note: "Works at the chat UI layer. Model capabilities depend on the selected route."
    },
    {
      id: "minimax", name: "MiniMax", url: "https://agent.minimax.io/", mode: "generic",
      hosts: ["agent.minimax.io", "minimax.io"], capabilities: { code: true, files: true, vision: true, roblox: true },
      note: "Generic adapter; MiniMax surfaces vary by account/product."
    },
    {
      id: "mimo", name: "MiMo models", url: "https://openrouter.ai/models", mode: "catalog",
      hosts: [], capabilities: { code: true, files: true, vision: true, roblox: true },
      note: "MiMo is exposed through model catalogs/routing services here rather than a dedicated chat adapter."
    }
  ];

  for (const p of providers) {
    p.roleScores = Object.freeze({ coder: 88, roblox: 86, planner: 88, qa: 86, reviewer: 88, threeD: 80, ...(p.roleScores || {}) });
    p.capabilities = Object.freeze({ code: false, files: false, vision: false, roblox: false, ...(p.capabilities || {}) });
    Object.freeze(p);
  }

  const byHost = new Map();
  const byId = new Map(providers.map((p) => [p.id, p]));
  for (const p of providers) for (const h of p.hosts) byHost.set(h, p);

  function current() {
    const host = String(location.hostname || "").toLowerCase();
    return byHost.get(host) || null;
  }

  function get(id) { return byId.get(id) || null; }
  function all() { return providers.slice(); }
  function enabled(settings, id) {
    return !settings?.enabledProviders || settings.enabledProviders.includes(id);
  }

  globalThis.NQYProviderRegistry = Object.freeze({ current, get, all, enabled });
})();
