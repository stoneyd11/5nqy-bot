// SPDX-License-Identifier: GPL-3.0-or-later
// Shared provider adapter contract. Provider code owns all DOM-specific details;
// the core only depends on these stable capabilities.
(() => {
  "use strict";
  const REQUIRED = [
    "id", "displayName", "init", "getEditor", "editorText", "typeAndSend",
    "stopGeneration", "isGenerating", "readAssistant", "snapshot",
  ];
  const OPTIONAL = [
    "findToolBlockSpot", "attachImages", "clearAttachments", "scanError",
    "turnHalted", "findContinueBtn", "clickContinueBtn", "conversationKey",
    "genDebug", "modeWarning", "unstableWarning", "promptExtra"
  ];
  function validate(adapter) {
    if (!adapter || typeof adapter !== "object") return { ok: false, missing: REQUIRED.slice() };
    const missing = REQUIRED.filter((key) => {
      if (["id", "displayName"].includes(key)) return !adapter[key];
      return typeof adapter[key] !== "function";
    });
    const badOptional = OPTIONAL.filter((key) => key in adapter && typeof adapter[key] !== "function" && !["modeWarning", "unstableWarning", "promptExtra"].includes(key));
    return { ok: missing.length === 0 && badOptional.length === 0, missing, badOptional };
  }
  function normalize(adapter) {
    const check = validate(adapter);
    if (!check.ok) throw new Error(`Provider adapter ${adapter?.id || "unknown"} is incomplete: ${[...check.missing, ...check.badOptional].join(", ")}`);
    return adapter;
  }
  globalThis.NQYProviderContract = Object.freeze({ REQUIRED, OPTIONAL, validate, normalize });
})();
