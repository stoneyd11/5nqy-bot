// 5nqy_devbot Ultra AI worker bridge.
// Keeps orchestration transport separate from provider-specific DOM code.
(() => {
  "use strict";
  const getApi = () => globalThis.NQYAgentBridge || null;
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || !String(msg.type || "").startsWith("nq-ultra-")) return;
    (async () => {
      const api = getApi();
      if (!api) return sendResponse({ ok: false, kind: "not-ready", error: "5nqy_devbot worker is not ready." });
      if (msg.type === "nq-ultra-state") return sendResponse(api.state());
      if (msg.type === "nq-ultra-start") return sendResponse(await api.start(msg.options || {}));
      if (msg.type === "nq-ultra-stop") return sendResponse(api.stop());
      if (msg.type === "nq-ultra-ask") return sendResponse(await api.ask(msg.prompt, msg.options || {}));
      sendResponse({ ok: false, error: "Unknown Ultra AI command." });
    })().catch((e) => sendResponse({ ok: false, kind: "exception", error: String(e?.message || e) }));
    return true;
  });
})();
