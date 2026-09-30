// SPDX-License-Identifier: GPL-3.0-or-later
// Generic DOM adapter for providers without a dedicated site-specific adapter.
// It never reaches into a provider's private APIs. It uses semantic DOM hints,
// MutationObserver-backed state, and fails closed when a safe composer/reply is
// not discoverable.
const ZSProvider = (() => {
  "use strict";
  const meta = globalThis.NQYProviderRegistry?.current() || {
    id: "generic", name: "AI provider", capabilities: { code: true, files: false, vision: false, roblox: true }
  };
  let diag = () => {};
  let editorLock = false;
  let genActive = false;
  let lastEditor = null;
  let observer = null;

  const timings = Object.freeze({
    RESPONSE_TIMEOUT_MS: 120000,
    STABLE_MS: 1800,
    WARMUP_MS: 500,
    REASON_NOREPLY_MS: 10000,
    SEND_SETTLE_MS: 900,
  });

  const q = (sels, root = document) => {
    for (const sel of sels) {
      try { const n = root.querySelector(sel); if (n) return n; } catch {}
    }
    return null;
  };
  const qa = (sels, root = document) => {
    const out = [];
    for (const sel of sels) {
      try { for (const n of root.querySelectorAll(sel)) if (!out.includes(n)) out.push(n); } catch {}
    }
    return out;
  };
  const visible = (n) => {
    if (!n || !n.isConnected) return false;
    const r = n.getBoundingClientRect();
    const cs = getComputedStyle(n);
    return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none";
  };
  const editorSelectors = [
    'textarea:not([disabled]):not([readonly])',
    '[contenteditable="true"]',
    '[role="textbox"][contenteditable="true"]',
    '[role="textbox"]',
    'div[aria-multiline="true"]'
  ];
  const sendSelectors = [
    'button[type="submit"]',
    'button[aria-label*="Send" i]',
    'button[title*="Send" i]',
    'button[data-testid*="send" i]',
    '[role="button"][aria-label*="Send" i]'
  ];
  const stopSelectors = [
    'button[aria-label*="Stop" i]',
    'button[title*="Stop" i]',
    'button[data-testid*="stop" i]',
    '[role="button"][aria-label*="Stop" i]'
  ];
  const assistantSelectors = [
    '[data-message-author-role="assistant"]',
    '[data-author="assistant"]',
    '[data-role="assistant"]',
    '[data-testid*="assistant-message" i]',
    '[class*="assistant-message" i]',
    '[class*="model-response" i]',
    '[class*="message-content" i]'
  ];

  function getEditor() {
    if (lastEditor && lastEditor.isConnected && visible(lastEditor)) return lastEditor;
    const candidates = qa(editorSelectors).filter(visible).filter((n) => {
      const rect = n.getBoundingClientRect();
      return rect.bottom >= innerHeight * 0.45 || rect.top >= innerHeight * 0.55;
    });
    lastEditor = candidates.sort((a,b) => b.getBoundingClientRect().bottom - a.getBoundingClientRect().bottom)[0] || null;
    return lastEditor;
  }
  const editorText = () => {
    const e = getEditor();
    return e ? ("value" in e ? e.value : e.innerText || e.textContent || "") : "";
  };
  const chatIsEmpty = () => assistantItems().length === 0 && userCount() === 0;
  const allItems = () => qa(assistantSelectors).filter(visible);
  const assistantItems = () => allItems().filter((n) => !/you|user/i.test(n.getAttribute("data-role") || n.getAttribute("data-message-author-role") || "assistant"));
  const userCount = () => qa(['[data-message-author-role="user"]','[data-author="user"]','[data-role="user"]']).length;
  const assistantCount = () => assistantItems().length;
  const lastAssistant = () => assistantItems().at(-1) || null;
  const lastAssistantId = () => {
    const n = lastAssistant();
    return n?.getAttribute("data-message-id") || n?.id || (n ? assistantItems().indexOf(n) : null);
  };
  const itemText = (item) => item?.innerText || item?.textContent || "";
  const classifyText = (item) => ({ text: itemText(item).trim(), node: item });
  const isAssistantItem = (item) => !!item && assistantItems().includes(item);
  const isUserItem = (item) => !!item && (/user/i.test(item.getAttribute("data-role") || item.getAttribute("data-message-author-role") || ""));
  const streamLen = () => { const i = lastAssistant(); return i ? itemText(i).length : 0; };
  const snapshot = () => ({ th: 0, rp: streamLen() });
  const readAssistant = () => {
    const item = lastAssistant();
    if (!item) return { present: false, reply: "", thinking: "", item: null };
    return { present: true, reply: itemText(item).trim(), thinking: "", item };
  };
  const isGenerating = () => !!q(stopSelectors) && visible(q(stopSelectors));
  const isBusyNow = isGenerating;
  const isHardGenerating = isGenerating;
  const editorFrame = () => getEditor()?.closest("form") || getEditor()?.parentElement || null;
  const composerFrame = editorFrame;
  const barMount = editorFrame;
  const coverTarget = () => getEditor();
  const chipAnchor = () => lastAssistant();
  const chipAppend = (item, node) => item?.appendChild?.(node);
  const chipAtItemLevel = true;
  const coverMaxH = 300;
  const coverOffsetY = 0;
  const coverPad = 0;
  const reliableCounts = false;
  const supportsVision = !!meta.capabilities?.vision;
  const modeWarning = meta.note || "Generic compatibility mode: website changes may require a dedicated adapter.";
  const unstableWarning = modeWarning;
  const promptExtra = "Use one command per reply. This provider is using the generic compatibility adapter; if the website changes, the extension will fall back safely instead of pretending a command ran.";

  function setValue(el, text) {
    if (!el) return false;
    if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value")?.set;
      setter ? setter.call(el, text) : (el.value = text);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    }
    el.focus();
    try {
      document.execCommand("selectAll", false);
      document.execCommand("insertText", false, text);
    } catch {
      el.textContent = text;
      el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
    }
    return true;
  }

  async function typeAndSend(text) {
    const ed = getEditor();
    if (!ed) return false;
    if (editorLock) return false;
    editorLock = true;
    try {
      setValue(ed, text);
      await new Promise((r) => setTimeout(r, 90));
      const send = q(sendSelectors);
      if (send && !send.disabled && visible(send)) { send.click(); return true; }
      const evt = new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true });
      ed.dispatchEvent(evt);
      return true;
    } finally {
      setTimeout(() => { editorLock = false; }, timings.SEND_SETTLE_MS);
    }
  }

  const stopGeneration = () => { const b = q(stopSelectors); if (b && visible(b)) { b.click(); return true; } return false; };
  const enforceComposer = () => ({ ready: !!getEditor() });
  const ensureComposerReady = () => ({ ready: !!getEditor() });
  const setInputLock = () => {};
  const turnHalted = () => false;
  const findContinueBtn = () => null;
  const clickContinueBtn = () => false;
  const scanError = () => null;
  const isTooLongMsg = () => false;
  const isBusyMsg = () => false;
  const captchaPresent = () => !!q(['iframe[src*="captcha" i]','[class*="captcha" i]']);
  const hasRegenerate = () => false;
  const findToolBlockSpot = () => null;
  const isComparisonTurn = () => false;
  const resolveComparison = () => false;
  const overlayBlocking = () => false;
  const openNewChat = () => false;
  const conversationKey = () => location.pathname || location.href;
  const isFreshChat = () => chatIsEmpty();
  const isEmpty = chatIsEmpty;
  const installSendHooks = () => {};
  const genDebug = () => ({ generic: true, provider: meta.id, generating: isGenerating(), editor: !!getEditor() });
  const replyUnsettled = false;
  const itemKey = lastAssistantId;
  const attachImages = () => false;
  const clearAttachments = () => {};

  function startObserver() {
    if (observer) return;
    const root = document.body || document.documentElement;
    if (!root) return;
    observer = new MutationObserver(() => { const next = getEditor(); genActive = isGenerating(); if (next !== lastEditor) diag("generic.editorChanged"); });
    observer.observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ["disabled", "aria-label", "data-state"] });
  }

  return {
    id: meta.id, displayName: meta.name, timings, supportsVision, promptExtra,
    modeWarning, unstableWarning, reliableCounts, chipAtItemLevel, coverMaxH, coverOffsetY, coverPad,
    allItems, isUserItem, isAssistantItem, itemText, classifyText, assistantCount, userCount,
    lastAssistant, lastAssistantId, itemKey, readAssistant, streamLen, snapshot,
    getEditor, editorText, chatIsEmpty, isFreshChat, composerFrame, barMount, coverTarget,
    chipAnchor, chipAppend, setInputLock, typeAndSend, stopGeneration,
    isGenerating, isBusyNow, isHardGenerating, genDebug, enforceComposer, ensureComposerReady,
    turnHalted, findContinueBtn, clickContinueBtn, scanError, isTooLongMsg, isBusyMsg,
    captchaPresent, hasRegenerate, findToolBlockSpot, isComparisonTurn, resolveComparison, overlayBlocking,
    openNewChat, conversationKey, installSendHooks, attachImages, clearAttachments, replyUnsettled,
    genActive,
    init({ diag: d } = {}) { if (d) diag = d; startObserver(); }
  };
})();
