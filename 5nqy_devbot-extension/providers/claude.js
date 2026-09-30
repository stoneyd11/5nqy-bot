// SPDX-License-Identifier: GPL-3.0-or-later
// providers/claude.js - the Anthropic Claude (claude.ai) provider.
// Uses the logged-in Claude web app; no Anthropic API key is required.
// The core agent loop remains provider-agnostic.
//
// Claude DOM notes (selectors checked against recent 2026 references):
//  - Composer: [data-testid="chat-input"] (ProseMirror/contenteditable).
//  - Send: button[data-testid="send-button"] with aria-label fallbacks.
//  - Assistant response: .font-claude-response, with several data-testid fallbacks.
//  - User message: [data-testid="human-message"] with class/testid fallbacks.
//  - Generation: stop button while Claude is producing a response.
//  - Conversation URLs are /chat/<uuid>.
//
// We intentionally keep vision/file attachment support OFF in this first Claude
// adapter. Text/tool execution is the important path; the bridge itself is unchanged.
// eslint-disable-next-line no-unused-vars
const ZSProvider = (() => {
  "use strict";

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let diag = () => {};
  let _locked = false;

  const S = {
    assistant: '.font-claude-response, [data-testid="ai-message"], [data-testid="message-assistant"], .font-claude-message, .assistant-message',
    user: '[data-testid="human-message"], [data-testid="user-message"], .font-user-message, .font-human-message, .user-message',
    editor: '[data-testid="chat-input"], [data-testid="chat-input-ssr"], .ProseMirror[contenteditable="true"]',
    send: 'button[data-testid="send-button"], button[data-testid="chat-input-send"], button[aria-label*="Send message" i], button[aria-label="Send" i]',
    stop: 'button[data-testid="stop-button"], button[aria-label*="Stop generating" i], button[aria-label^="Stop" i]',
    reply: '.font-claude-response, .standard-markdown, .progressive-markdown, .markdown, .prose',
    code: 'pre, [data-testid*="code-block"], [class*="code-block"]',
    errorSurfaces: '[role="alert"],[data-testid*="error" i],[class*="error" i],[class*="alert" i]',
  };

  const RE = {
    contextLimit: /(conversation|context).{0,40}(too long|limit|exceeded|max|maximum)|maximum.{0,30}(context|length)|token.{0,20}limit|message.{0,30}too long/i,
    tooLong: /(conversation|context).{0,40}(too long|limit|exceeded|max|maximum)|message.{0,30}too long/i,
    busy: /something went wrong|try again later|temporarily unavailable|rate limit|too many requests|capacity|overloaded/i,
    continueBtn: /^(continue|continue generating)$/i,
  };

  const timings = {
    GEN_IDLE_MS: 1800,
    REASON_IDLE_MS: 12000,
    WARMUP_MS: 45000,
    REASON_NOREPLY_MS: 90000,
    STABLE_MS: 7000,
    RESPONSE_TIMEOUT_MS: 300000,
  };

  const clean = (s) => String(s || "").replace(/\u00a0/g, " ");

  function isVisible(el) {
    return !!el && el.offsetParent !== null && getComputedStyle(el).visibility !== "hidden";
  }

  function getEditor() {
    const nodes = [...document.querySelectorAll(S.editor)];
    return nodes.find(isVisible) || nodes.find((n) => n.isConnected) || null;
  }

  function editorText() {
    const ed = getEditor();
    return ed ? clean(ed.innerText || ed.textContent || "") : "";
  }

  function assistantItems() {
    const seen = new Set();
    const out = [];
    for (const el of document.querySelectorAll(S.assistant)) {
      if (!seen.has(el)) { seen.add(el); out.push(el); }
    }
    out.sort((a, b) => {
      if (a === b) return 0;
      const pos = a.compareDocumentPosition(b);
      return (pos & Node.DOCUMENT_POSITION_FOLLOWING) ? -1 : 1;
    });
    return out;
  }

  function userItems() {
    const seen = new Set();
    const out = [];
    for (const el of document.querySelectorAll(S.user)) {
      if (!seen.has(el)) { seen.add(el); out.push(el); }
    }
    out.sort((a, b) => {
      const pos = a.compareDocumentPosition(b);
      return (pos & Node.DOCUMENT_POSITION_FOLLOWING) ? -1 : 1;
    });
    return out;
  }

  function allItems() {
    const out = [...assistantItems(), ...userItems()];
    const seen = new Set();
    out.forEach(() => {});
    const unique = out.filter((el) => !seen.has(el) && (seen.add(el), true));
    unique.sort((a, b) => {
      const pos = a.compareDocumentPosition(b);
      return (pos & Node.DOCUMENT_POSITION_FOLLOWING) ? -1 : 1;
    });
    return unique;
  }

  const isAssistantItem = (item) => !!item && (
    item.matches?.(S.assistant) || !!item.querySelector?.(S.assistant)
  );
  const isUserItem = (item) => !!item && !isAssistantItem(item) && (
    item.matches?.(S.user) || !!item.querySelector?.(S.user)
  );
  const assistantCount = () => assistantItems().length;
  const userCount = () => userItems().length;
  const lastAssistant = () => {
    const a = assistantItems();
    return a.length ? a[a.length - 1] : null;
  };

  const idMap = new WeakMap();
  let idSeq = 0;
  function itemKey(item) {
    if (!item) return null;
    for (const attr of ["data-message-id", "data-id", "data-testid"]) {
      const v = item.getAttribute?.(attr);
      if (v && attr !== "data-testid") return v;
    }
    let id = idMap.get(item);
    if (!id) { id = `claude-${++idSeq}`; idMap.set(item, id); }
    return id;
  }
  const lastAssistantId = () => itemKey(lastAssistant());

  function isBlockTag(tag) {
    return /^(P|DIV|PRE|LI|UL|OL|BLOCKQUOTE|H[1-6]|TABLE|TR|SECTION|ARTICLE|HR)$/i.test(tag || "");
  }

  function textWithout(root, excludeSel) {
    if (!root) return "";
    let t = "";
    const walk = (n) => {
      if (n.nodeType === Node.TEXT_NODE) { t += n.nodeValue || ""; return; }
      if (n.nodeType !== Node.ELEMENT_NODE) return;
      const el = n;
      if (excludeSel && el.matches?.(excludeSel)) return;
      if (el.matches?.(".zs-chip")) return;
      if (el.tagName === "BR") { t += "\n"; return; }
      if (el.tagName === "PRE") {
        const v = el.innerText || el.textContent || "";
        if (t && !t.endsWith("\n")) t += "\n";
        t += v;
        if (!t.endsWith("\n")) t += "\n";
        return;
      }
      const block = isBlockTag(el.tagName);
      if (block && t && !t.endsWith("\n")) t += "\n";
      for (const c of el.childNodes) walk(c);
      if (block && !t.endsWith("\n")) t += "\n";
    };
    walk(root);
    return t.replace(/\n{3,}/g, "\n\n");
  }

  function itemText(item) {
    if (!item) return "";
    const body = isAssistantItem(item) ? item : item;
    const replies = body.querySelectorAll?.(S.reply);
    if (isAssistantItem(item) && replies?.length) {
      return [...replies].map((r) => textWithout(r)).join("\n").trim();
    }
    return textWithout(body).trim();
  }

  function classifyText(item, excludeSel) {
    if (!item) return "";
    const replies = item.querySelectorAll?.(S.reply);
    if (isAssistantItem(item) && replies?.length) {
      return [...replies]
        .filter((r) => !(excludeSel && r.closest(excludeSel)))
        .map((r) => textWithout(r, excludeSel)).join("\n").trim();
    }
    return textWithout(item, excludeSel).trim();
  }

  function chatIsEmpty() {
    return assistantCount() === 0 && userCount() === 0;
  }

  function isFreshChat() {
    return chatIsEmpty() || location.pathname === "/" || /^\/new\/?$/.test(location.pathname);
  }

  function composerFrame() {
    const ed = getEditor();
    if (!ed) return null;
    return ed.closest("form") || ed.closest('[class*="composer" i]') || ed.parentElement || ed;
  }

  function barAnchor() { return composerFrame(); }
  function coverTarget() { return composerFrame() || getEditor(); }

  function setInputLock(on) {
    _locked = !!on;
    const ed = getEditor();
    if (!ed) return;
    if (on) {
      ed.setAttribute("data-zs-locked", "1");
      ed.style.pointerEvents = "none";
    } else {
      ed.removeAttribute("data-zs-locked");
      ed.style.pointerEvents = "";
    }
  }

  function selectAll(ed) {
    ed.focus();
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(ed);
    sel.removeAllRanges();
    sel.addRange(range);
  }

  async function typeText(ed, text) {
    selectAll(ed);
    // Claude's composer is ProseMirror/contenteditable. execCommand is the
    // important part: it goes through the editor's editing pipeline and updates
    // the framework state instead of mutating innerHTML behind its back.
    document.execCommand("insertText", false, String(text));
    await new Promise((r) => setTimeout(r, 40));
  }

  const submitButton = () => {
    const nodes = [...document.querySelectorAll(S.send)];
    return nodes.find(isVisible) || null;
  };
  const stopButton = () => {
    const nodes = [...document.querySelectorAll(S.stop)];
    return nodes.find(isVisible) || null;
  };

  let streamItem = null;
  let streamMax = -1;
  let streamAt = 0;
  function sampleStream() {
    const item = lastAssistant();
    const len = itemText(item).length;
    const now = Date.now();
    if (item !== streamItem || len < streamMax - 400) {
      streamItem = item; streamMax = len; streamAt = now; return;
    }
    if (len > streamMax) { streamMax = len; streamAt = now; }
  }
  function isGenerating() {
    sampleStream();
    const stop = !!stopButton();
    const recent = streamMax > 1 && (Date.now() - streamAt) < timings.GEN_IDLE_MS;
    return stop || recent;
  }
  const isBusyNow = isGenerating;
  const isHardGenerating = isGenerating;
  const streamLen = (item) => itemText(item === undefined ? lastAssistant() : item).length;

  function snapshot() {
    const item = lastAssistant();
    return { th: 0, rp: itemText(item).length };
  }

  function readAssistant() {
    const item = lastAssistant();
    if (!item) return { present: false, reply: "", thinking: "", item: null };
    return { present: true, reply: itemText(item), thinking: "", item };
  }

  function findContinueBtn() {
    for (const b of document.querySelectorAll("button")) {
      if (!isVisible(b)) continue;
      if (RE.continueBtn.test(clean(b.innerText).trim())) return b;
    }
    return null;
  }
  function clickContinueBtn() {
    const b = findContinueBtn();
    if (!b) return false;
    try { b.click(); return true; } catch { return false; }
  }

  function stopGeneration() {
    const b = stopButton();
    if (b) { try { b.click(); } catch {} }
  }

  function enforceComposer() {
    return { ready: !!getEditor() };
  }

  async function ensureComposerReady(reason) {
    const ready = !!getEditor();
    diag("mode_ready", { reason, provider: "claude", ready });
    return { ready };
  }

  const modeWarning = () => "";
  const captchaPresent = () => {
    if (document.querySelector(".cf-turnstile, iframe[src*='turnstile' i]")) return true;
    const body = clean(document.body?.innerText || "").slice(0, 6000);
    return /verify you are human|checking your browser|turnstile/i.test(body) && !getEditor();
  };
  const overlayBlocking = () => {
    for (const d of document.querySelectorAll('[role="dialog"]')) {
      if (d.closest("#zs-root")) continue;
      if (isVisible(d)) return true;
    }
    return false;
  };

  function scanError() {
    try {
      for (const el of document.querySelectorAll(S.errorSurfaces)) {
        if (!isVisible(el)) continue;
        if (el.closest(S.assistant) || el.closest(S.user)) continue;
        const t = clean(el.innerText).trim();
        if (t.length > 8 && t.length < 700 && RE.contextLimit.test(t)) return t.slice(0, 260);
      }
    } catch {}
    if (!getEditor()) return "The Claude input box disappeared (session may have ended or Claude may be loading).";
    return null;
  }

  const isTooLongMsg = (text) => RE.tooLong.test(text || "");
  const isBusyMsg = (text) => RE.busy.test(text || "");
  const turnHalted = () => false;

  async function waitFor(pred, timeout) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      try { if (pred()) return true; } catch {}
      await sleep(100);
    }
    return false;
  }

  async function typeAndSend(text) {
    const ed = getEditor();
    if (!ed) throw new Error("Claude input box not found");
    const relock = _locked;
    if (relock) ed.style.pointerEvents = "auto";
    try {
      await typeText(ed, text);
      await waitFor(() => editorText().trim().length > 0, 2000);
      const btn = submitButton();
      if (btn && !btn.disabled && btn.getAttribute("aria-disabled") !== "true") {
        btn.click();
        return;
      }
      // Enter fallback. Claude's normal composer submit is also bound to Enter.
      const ev = { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true };
      ed.dispatchEvent(new KeyboardEvent("keydown", ev));
      ed.dispatchEvent(new KeyboardEvent("keyup", ev));
    } finally {
      if (relock) ed.style.pointerEvents = "none";
    }
  }

  const conversationKey = () => {
    const m = location.pathname.match(/^\/chat\/([^/]+)/);
    return m ? `/chat/${m[1]}` : "";
  };

  function installSendHooks(handlers) {
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" || e.shiftKey || e.isComposing) return;
      const ed = getEditor();
      if (!ed || !ed.contains(e.target)) return;
      if (!editorText().trim() || handlers.isBlocked()) return;
      if (!handlers.isStarted()) {
        if (!chatIsEmpty()) return;
        handlers.onBlockedAttempt();
        return;
      }
      handlers.onUserMessage(assistantCount());
    }, true);

    document.addEventListener("click", (e) => {
      const btn = e.target?.closest?.("button");
      if (!btn) return;
      if (btn.matches(S.stop)) { handlers.onNativeStop(); return; }
      if (!btn.matches(S.send)) return;
      if (btn.disabled || btn.getAttribute("aria-disabled") === "true" || handlers.isBlocked()) return;
      if (!handlers.isStarted()) {
        if (!chatIsEmpty()) return;
        handlers.onBlockedAttempt();
        return;
      }
      handlers.onUserMessage(assistantCount());
    }, true);
  }

  const CMD_SHAPE = /"(?:command|tool)"\s*:\s*"|###\s*lua|###mcp_tool###/i;
  const CMD_OPEN = /###\s*(?:LUA|MCP_TOOL)\s*###/i;
  const CMD_CLOSE = /###\s*END_(?:LUA|MCP_TOOL)\s*###/i;

  function findToolBlockSpot(item) {
    if (!item) return null;
    const replyRoots = [...item.querySelectorAll(S.reply)];
    let spot = null;
    const roots = replyRoots.length ? replyRoots : [item];
    for (const root of roots) {
      const blocks = [...root.querySelectorAll(S.code)];
      for (const block of blocks) {
        if (block.closest(".zs-chip")) continue;
        if (CMD_SHAPE.test(block.innerText || block.textContent || "")) {
          block.classList.add("zs-tool-hide");
          root.classList.add("zs-cmd-mask");
          spot ||= { parent: block.parentElement, ref: block };
        }
      }
      const kids = [...root.children];
      for (let i = 0; i < kids.length; i++) {
        const t = clean(kids[i].innerText || kids[i].textContent || "");
        if (!t || kids[i].classList.contains("zs-chip") || kids[i].closest("pre")) continue;
        if (CMD_SHAPE.test(t) && /^[{#]/.test(t.replace(/^json\s*/i, ""))) {
          kids[i].classList.add("zs-tool-hide");
          spot ||= { parent: kids[i].parentElement, ref: kids[i] };
        }
      }
      const kids2 = [...root.children];
      for (let i = 0; i < kids2.length; i++) {
        const t = clean(kids2[i].innerText || kids2[i].textContent || "");
        if (!CMD_OPEN.test(t)) continue;
        for (let j = i; j < kids2.length; j++) {
          kids2[j].classList.add("zs-tool-hide");
          spot ||= { parent: kids2[j].parentElement, ref: kids2[j] };
          if (CMD_CLOSE.test(clean(kids2[j].innerText || kids2[j].textContent || ""))) { i = j; break; }
        }
      }
    }
    return spot;
  }

  function genDebug() {
    return {
      stop: !!stopButton(),
      streamMax,
      streamAgeMs: streamAt ? Date.now() - streamAt : -1,
      item: !!lastAssistant(),
    };
  }

  return {
    id: "claude",
    displayName: "Claude",
    supportsVision: false,
    timings,
    chipAtItemLevel: true,
    reliableCounts: true,
    init({ diag: d } = {}) { if (d) diag = d; },
    allItems, isUserItem, isAssistantItem, itemText, classifyText,
    assistantCount, userCount, lastAssistant, lastAssistantId, itemKey,
    readAssistant, streamLen, snapshot,
    getEditor, editorText, chatIsEmpty, isFreshChat, composerFrame, barAnchor, coverTarget,
    coverMaxH: 280,
    setInputLock, typeAndSend, stopGeneration,
    isGenerating, isBusyNow, isHardGenerating,
    enforceComposer, ensureComposerReady, modeWarning, captchaPresent, overlayBlocking,
    turnHalted, findContinueBtn, clickContinueBtn,
    scanError, isTooLongMsg, isBusyMsg,
    conversationKey, installSendHooks, findToolBlockSpot,
    genDebug,
  };
})();
