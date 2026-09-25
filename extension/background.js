// Background service worker for Open Claude in Chrome extension.
// Handles: native messaging, CDP via chrome.debugger, tool dispatch, tab group management.

importScripts("audit/redact.js", "audit/store.js", "audit/audit.js");

// Prevent unhandled rejections from killing the service worker
self.addEventListener("unhandledrejection", (event) => {
  event.preventDefault();
});

const NATIVE_HOST_NAME = "com.anthropic.open_claude_in_chrome";

// --- State ---
let nativePort = null;
let tabGroupId = null;
let tabGroupTabs = new Set();
const attachedTabs = new Map(); // tabId -> { enabledDomains: Set }
const consoleMessages = new Map(); // tabId -> [{level, text, timestamp, url}]
const networkRequests = new Map(); // tabId -> [{url, method, status, type, timestamp}]
const screenshotStore = new Map(); // imageId -> base64
const openDialogs = new Map(); // tabId -> message, while a JS dialog (alert/confirm/prompt/beforeunload) blocks the page
const pendingCdpRejects = new Map(); // tabId -> Set<reject>, one entry per in-flight rawCdp call on that tab

// Thrown to reject every pending rawCdp call on a tab the instant its dialog opens, instead of
// letting each one run out its own CDP_TIMEOUT_MS: a dialog freezes the renderer, so an
// in-flight command (e.g. the click that opened it) is stuck until the user closes it
// regardless of how it's reported. dialogMessage lets a caller (e.g. a click action) report that
// its own action already happened before the dialog interrupted the rest.
class DialogOpenedDuringCall extends Error {
  constructor(message) {
    super(`A JavaScript dialog opened during this call ("${message}").`);
    this.dialogMessage = message;
  }
}

// --- Keep-alive alarm ---
chrome.alarms.create("keepalive", { periodInMinutes: 0.4 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "keepalive") {
    if (!nativePort) connectNativeHost();
  }
});

// --- Native messaging ---
function connectNativeHost() {
  if (nativePort) return;
  try {
    nativePort = chrome.runtime.connectNative(NATIVE_HOST_NAME);

    nativePort.onMessage.addListener((msg) => {
      if (msg.type === "tool_request" && msg.id) {
        if (!firstDelivery(msg.id)) {
          console.warn("Ignoring duplicate tool_request", msg.id);
          return;
        }
        handleToolRequest(msg.id, msg.tool, msg.args || {}, msg.session);
      }
    });

    nativePort.onDisconnect.addListener(() => {
      const err = chrome.runtime.lastError;
      nativePort = null;
      // Retry in 2 seconds
      setTimeout(connectNativeHost, 2000);
    });
  } catch (e) {
    nativePort = null;
    setTimeout(connectNativeHost, 2000);
  }
}

function sendResponse(id, result) {
  if (!nativePort) return;
  try {
    nativePort.postMessage({ id, type: "tool_response", result });
  } catch {
    // Port disconnected
  }
}

function sendError(id, error) {
  if (!nativePort) return;
  try {
    nativePort.postMessage({ id, type: "tool_error", error: String(error) });
  } catch {
    // Port disconnected
  }
}

// --- Duplicate request dedupe ---
// Keeps the ids of the last 500 delivered tool_requests for 10 minutes, so a frame the same
// hub process happens to deliver twice is ignored instead of running twice. Not a reconnect
// guard: a new hub process always mints a fresh runId, so ids never collide across those.
const DEDUPE_TTL_MS = 10 * 60 * 1000;
const DEDUPE_MAX_IDS = 500;
const deliveredIds = new Map(); // id -> first-seen timestamp, in insertion order

function firstDelivery(id) {
  const now = Date.now();
  for (const [seenId, seenAt] of deliveredIds) {
    if (now - seenAt > DEDUPE_TTL_MS) deliveredIds.delete(seenId);
  }
  if (deliveredIds.has(id)) return false;
  deliveredIds.set(id, now);
  while (deliveredIds.size > DEDUPE_MAX_IDS) {
    deliveredIds.delete(deliveredIds.keys().next().value);
  }
  return true;
}

// --- Tab group management ---
async function ensureTabGroup(createIfEmpty) {
  // Check if our tab group still exists
  if (tabGroupId !== null) {
    try {
      const group = await chrome.tabGroups.get(tabGroupId);
      if (group) {
        // Verify tabs are still in the group
        const tabs = await chrome.tabs.query({ groupId: tabGroupId });
        tabGroupTabs = new Set(tabs.map((t) => t.id));
        if (tabGroupTabs.size > 0) return;
      }
    } catch {
      tabGroupId = null;
      tabGroupTabs.clear();
    }
  }

  if (!createIfEmpty) return;

  // Create a new window with a tab, group it
  const win = await chrome.windows.create({ focused: true, url: "about:blank" });
  const tab = win.tabs[0];
  const groupId = await chrome.tabs.group({ tabIds: [tab.id] });
  await chrome.tabGroups.update(groupId, { title: "MCP", color: "blue" });
  tabGroupId = groupId;
  tabGroupTabs = new Set([tab.id]);
}

function formatTabContext(tabs) {
  // A blocked tab (a local file, or this extension's own page) stays listed so the agent can
  // see it exists, but with no title and no real URL. The agent can't act on it anyway (every
  // tool that takes a tabId refuses it via tabAccessError above).
  const available = tabs.map((t) =>
    isBlockedUrl(t.url || "", chrome.runtime.id)
      ? { tabId: t.id, title: "", url: "(blocked)" }
      : { tabId: t.id, title: t.title || "Untitled", url: t.url || "" }
  );

  let text = `Tab Context:\n- Available tabs:\n`;
  for (const t of available) {
    text += t.url === "(blocked)"
      ? `  \u2022 tabId ${t.tabId}: (blocked)\n`
      : `  \u2022 tabId ${t.tabId}: "${t.title}" (${t.url})\n`;
  }

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({ availableTabs: available, tabGroupId }) + "\n\n" + text,
      },
    ],
  };
}

// Single check used by every tool handler that takes a tabId: not in the MCP group, showing a
// local file or this extension's own page (also reached via back/forward, or a tab dragged into
// the group by hand — see isBlockedUrl below), or blocked behind an open JS dialog. Returns null
// when tabId is fine to use, or the exact refusal text to show the agent otherwise.
//   allowBlockedUrl: skip the file:/own-origin check (tabs_close_mcp only — closing such a tab
//     doesn't read or act on it, so it's harmless, and it's the agent's only way to clean one up).
//   allowDialog: skip the open-dialog check, for tools that don't need the page to be responsive
//     (tabs_close_mcp and navigate — closing or navigating a tab dismisses its dialog anyway;
//     resize_window — window.get/update are browser-level and readViewport already degrades to
//     null within its own short budget instead of hanging).
async function tabAccessError(tabId, { allowBlockedUrl = false, allowDialog = false } = {}) {
  // Always check live state — in-memory tabGroupTabs can be stale after service worker restart
  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    return `Tab ${tabId} is not in the MCP group.`;
  }

  let inGroup;
  if (tab.groupId !== -1) {
    // Recover tabGroupId if we lost it (service worker restart)
    if (tabGroupId === null) {
      try {
        const group = await chrome.tabGroups.get(tab.groupId);
        if (group.title === "MCP") {
          tabGroupId = group.id;
          const groupTabs = await chrome.tabs.query({ groupId: tabGroupId });
          tabGroupTabs = new Set(groupTabs.map((t) => t.id));
        }
      } catch {}
    }
    inGroup = tab.groupId === tabGroupId;
  } else {
    inGroup = tabGroupTabs.has(tabId);
  }
  if (!inGroup) return `Tab ${tabId} is not in the MCP group.`;

  if (!allowBlockedUrl && isBlockedUrl(tab.url, chrome.runtime.id)) {
    return `Tab ${tabId} shows a local file or this extension's own page, which the agent cannot use.`;
  }

  if (!allowDialog && openDialogs.has(tabId)) {
    return `A JavaScript dialog is open on this tab ("${openDialogs.get(tabId)}"). It blocks the page until the user closes it.`;
  }

  return null;
}

// --- CDP helpers ---
const CDP_TIMEOUT_MS = 30000;
const PRE_ATTACH_BUDGET_MS = 2000; // how long navigate waits for its attach before it navigates anyway
const attaching = new Map(); // tabId -> in-flight attach promise, shared by parallel callers

function rawCdp(tabId, method, params = {}, timeoutMs = CDP_TIMEOUT_MS) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`CDP ${method} timed out after ${timeoutMs / 1000}s`)), timeoutMs);
  });
  // Raced alongside the command itself: if a dialog opens on this tab before it settles, reject
  // right away instead of waiting out timeoutMs for what a dialog has already frozen.
  let rejectOnDialog;
  const dialogAbort = new Promise((_, reject) => {
    rejectOnDialog = reject;
    let waiters = pendingCdpRejects.get(tabId);
    if (!waiters) { waiters = new Set(); pendingCdpRejects.set(tabId, waiters); }
    waiters.add(rejectOnDialog);
  });
  return Promise.race([chrome.debugger.sendCommand({ tabId }, method, params), timeout, dialogAbort]).finally(() => {
    clearTimeout(timer);
    pendingCdpRejects.get(tabId)?.delete(rejectOnDialog);
  });
}

async function ensureAttached(tabId) {
  if (attachedTabs.has(tabId)) return;
  let pending = attaching.get(tabId);
  if (!pending) {
    pending = (async () => {
      await chrome.debugger.attach({ tabId }, "1.3");
      try {
        // Pin devicePixelRatio to 1 so screenshots use CSS pixels, the coordinate space of
        // Input.dispatchMouseEvent. Width and height 0 leave the viewport size alone, so the
        // page keeps following the real window (resize_window, window chrome).
        await rawCdp(tabId, "Emulation.setDeviceMetricsOverride", { width: 0, height: 0, deviceScaleFactor: 1, mobile: false });
        // Enabled unconditionally, not lazily via ensureDomain like Console/Network below, so a
        // dialog opened before any tool asks for the Page domain is still tracked (see
        // openDialogs and the onEvent listener below).
        await rawCdp(tabId, "Page.enable", {});
      } catch (err) {
        try { await chrome.debugger.detach({ tabId }); } catch {}
        throw err;
      }
      // Only mark the tab attached once the pin has actually taken effect, so a caller that
      // joins mid-flight (below) never runs a command before it, and a failed pin never leaves
      // attachedTabs pointing at a tab whose debugger session we just tore down.
      attachedTabs.set(tabId, { enabledDomains: new Set(["Page"]) });
    })().finally(() => {
      // Guard against deleting a NEWER attempt: if the tab got detached and re-attached while
      // this attempt was still in flight, `attaching` may already hold someone else's promise.
      if (attaching.get(tabId) === pending) attaching.delete(tabId);
    });
    attaching.set(tabId, pending);
  }
  return pending;
}

async function ensureDomain(tabId, domain) {
  const state = attachedTabs.get(tabId);
  if (!state) throw new Error("Not attached to tab");
  if (state.enabledDomains.has(domain)) return;
  await rawCdp(tabId, `${domain}.enable`, {});
  state.enabledDomains.add(domain);
}

async function cdp(tabId, method, params = {}, timeoutMs) {
  await ensureAttached(tabId);
  return rawCdp(tabId, method, params, timeoutMs);
}

// Read the page's viewport size, e.g. for the screenshot/read_page/resize_window
// replies. Returns null instead of throwing so callers can just omit that part of
// their message (for example on a chrome:// page that refuses to attach, or one
// that's stuck on an open JS dialog and won't answer Runtime.evaluate at all). A
// viewport read is trivial, so it gets a short default timeout instead of
// inheriting cdp()'s full 30s — callers with a tighter budget (resize_window) pass
// their own.
async function readViewport(tabId, timeoutMs = 2000) {
  try {
    const result = await cdp(tabId, "Runtime.evaluate", {
      expression: "[innerWidth, innerHeight]",
      returnByValue: true,
    }, timeoutMs);
    const value = result?.result?.value;
    if (result?.exceptionDetails || !Array.isArray(value)) return null;
    const [width, height] = value;
    return { width, height };
  } catch {
    return null;
  }
}

// Clean up when tab is closed
chrome.tabs.onRemoved.addListener((tabId) => {
  tabGroupTabs.delete(tabId);
  if (attachedTabs.has(tabId)) {
    try { chrome.debugger.detach({ tabId }); } catch {}
    attachedTabs.delete(tabId);
  }
  attaching.delete(tabId);
  consoleMessages.delete(tabId);
  networkRequests.delete(tabId);
  openDialogs.delete(tabId);
  pendingCdpRejects.delete(tabId);
});

// Handle user dismissing debugger bar
chrome.debugger.onDetach.addListener((source, reason) => {
  attachedTabs.delete(source.tabId);
  attaching.delete(source.tabId);
  openDialogs.delete(source.tabId);
  pendingCdpRejects.delete(source.tabId);
});

// --- CDP event listeners for dialogs, console and network ---
chrome.debugger.onEvent.addListener((source, method, params) => {
  const tabId = source.tabId;

  // A JS dialog (alert/confirm/prompt/beforeunload) freezes the page until the user answers
  // it: CDP commands against the page either silently no-op (Input.dispatchKeyEvent) or hang
  // until it closes (Runtime.evaluate, Page.captureScreenshot). tabAccessError checks this
  // before a tool handler ever reaches one of those, instead of reporting a false success or
  // waiting out a long timeout. A dialog opened mid-call (e.g. an onclick handler calling
  // confirm()) is different: the call was already in flight, so reject it now instead of
  // leaving it to run out rawCdp's own timeout for what's already frozen.
  if (method === "Page.javascriptDialogOpening") {
    openDialogs.set(tabId, params.message || "");
    const waiters = pendingCdpRejects.get(tabId);
    if (waiters) {
      for (const reject of waiters) reject(new DialogOpenedDuringCall(params.message || ""));
      waiters.clear();
    }
  }
  if (method === "Page.javascriptDialogClosed") {
    openDialogs.delete(tabId);
  }

  if (method === "Console.messageAdded" && params.message) {
    const msgs = consoleMessages.get(tabId) || [];
    msgs.push({
      level: params.message.level,
      text: params.message.text,
      url: params.message.url || "",
      timestamp: Date.now(),
    });
    // Keep last 1000
    if (msgs.length > 1000) msgs.splice(0, msgs.length - 1000);
    consoleMessages.set(tabId, msgs);
  }

  if (method === "Runtime.consoleAPICalled" && params.args) {
    const msgs = consoleMessages.get(tabId) || [];
    const text = params.args.map((a) => a.value ?? a.description ?? "").join(" ");
    msgs.push({
      level: params.type || "log",
      text,
      url: params.stackTrace?.callFrames?.[0]?.url || "",
      timestamp: Date.now(),
    });
    if (msgs.length > 1000) msgs.splice(0, msgs.length - 1000);
    consoleMessages.set(tabId, msgs);
  }

  if (method === "Network.responseReceived" && params.response) {
    const reqs = networkRequests.get(tabId) || [];
    // Fill in the response on the request we already logged (matched by
    // requestId) instead of appending a second entry with a guessed method.
    const entry = reqs.findLast((r) => r.requestId === params.requestId);
    if (entry) {
      entry.status = params.response.status;
      entry.statusText = params.response.statusText;
      entry.mimeType = params.response.mimeType;
    } else {
      reqs.push({
        requestId: params.requestId,
        url: params.response.url,
        method: "",
        status: params.response.status,
        statusText: params.response.statusText,
        type: params.type || "Other",
        mimeType: params.response.mimeType,
        timestamp: Date.now(),
      });
      if (reqs.length > 1000) reqs.splice(0, reqs.length - 1000);
      networkRequests.set(tabId, reqs);
    }
  }

  if (method === "Network.requestWillBeSent" && params.request) {
    const reqs = networkRequests.get(tabId) || [];
    if (params.redirectResponse) {
      // This requestId is following a redirect: retire the hop that just redirected
      // (so it stops matching future updates for this requestId) and record the
      // redirect's own status on it, then fall through to log the new hop below.
      const redirected = reqs.findLast((r) => r.requestId === params.requestId);
      if (redirected) {
        redirected.status = params.redirectResponse.status;
        redirected.statusText = params.redirectResponse.statusText;
        redirected.mimeType = params.redirectResponse.mimeType;
        redirected.requestId = null;
      }
    }
    reqs.push({
      requestId: params.requestId,
      url: params.request.url,
      method: params.request.method,
      status: 0,
      type: params.type || "Other",
      timestamp: Date.now(),
    });
    if (reqs.length > 1000) reqs.splice(0, reqs.length - 1000);
    networkRequests.set(tabId, reqs);
  }
});

// --- Keyboard ---
// DOM key, code, Windows virtual key code, and the text a key press inserts (US layout).
const NAMED_KEYS = {
  Enter: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
  Tab: { key: "Tab", code: "Tab", keyCode: 9 },
  Escape: { key: "Escape", code: "Escape", keyCode: 27 },
  Backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
  Delete: { key: "Delete", code: "Delete", keyCode: 46 },
  Space: { key: " ", code: "Space", keyCode: 32, text: " " },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  ArrowRight: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  Home: { key: "Home", code: "Home", keyCode: 36 },
  End: { key: "End", code: "End", keyCode: 35 },
  PageUp: { key: "PageUp", code: "PageUp", keyCode: 33 },
  PageDown: { key: "PageDown", code: "PageDown", keyCode: 34 },
  Insert: { key: "Insert", code: "Insert", keyCode: 45 },
};
for (let i = 1; i <= 12; i++) NAMED_KEYS[`F${i}`] = { key: `F${i}`, code: `F${i}`, keyCode: 111 + i };

const KEY_ALIASES = {
  enter: "Enter", return: "Enter", kp_enter: "Enter", tab: "Tab", escape: "Escape", esc: "Escape",
  backspace: "Backspace", back_space: "Backspace", delete: "Delete", del: "Delete", space: "Space",
  arrowup: "ArrowUp", arrowdown: "ArrowDown", arrowleft: "ArrowLeft", arrowright: "ArrowRight",
  up: "ArrowUp", down: "ArrowDown", left: "ArrowLeft", right: "ArrowRight", home: "Home", end: "End",
  pageup: "PageUp", page_up: "PageUp", prior: "PageUp", pagedown: "PageDown", page_down: "PageDown",
  next: "PageDown", insert: "Insert",
};

const SHIFTED_DIGITS = { ")": "0", "!": "1", "@": "2", "#": "3", "$": "4", "%": "5", "^": "6", "&": "7", "*": "8", "(": "9" };
const PUNCTUATION = {
  " ": ["Space", 32, false], "-": ["Minus", 189, false], "_": ["Minus", 189, true], "=": ["Equal", 187, false],
  "+": ["Equal", 187, true], "[": ["BracketLeft", 219, false], "{": ["BracketLeft", 219, true],
  "]": ["BracketRight", 221, false], "}": ["BracketRight", 221, true], "\\": ["Backslash", 220, false],
  "|": ["Backslash", 220, true], ";": ["Semicolon", 186, false], ":": ["Semicolon", 186, true],
  "'": ["Quote", 222, false], "\"": ["Quote", 222, true], ",": ["Comma", 188, false], "<": ["Comma", 188, true],
  ".": ["Period", 190, false], ">": ["Period", 190, true], "/": ["Slash", 191, false], "?": ["Slash", 191, true],
  "`": ["Backquote", 192, false], "~": ["Backquote", 192, true],
};

// The key a US keyboard uses to produce this character, or null (then it is inserted as text).
function charDefinition(ch) {
  if (/^[a-z]$/.test(ch)) return { key: ch, code: `Key${ch.toUpperCase()}`, keyCode: ch.toUpperCase().charCodeAt(0), text: ch, shift: false };
  if (/^[A-Z]$/.test(ch)) return { key: ch, code: `Key${ch}`, keyCode: ch.charCodeAt(0), text: ch, shift: true };
  if (/^[0-9]$/.test(ch)) return { key: ch, code: `Digit${ch}`, keyCode: ch.charCodeAt(0), text: ch, shift: false };
  // Object.hasOwn, not `in` or a truthy read: ch could otherwise match an inherited
  // Object.prototype name and resolve to that (non-key) value.
  if (Object.hasOwn(SHIFTED_DIGITS, ch)) return { key: ch, code: `Digit${SHIFTED_DIGITS[ch]}`, keyCode: SHIFTED_DIGITS[ch].charCodeAt(0), text: ch, shift: true };
  if (Object.hasOwn(PUNCTUATION, ch)) {
    const [code, keyCode, shift] = PUNCTUATION[ch];
    return { key: ch, code, keyCode, text: ch, shift };
  }
  return null;
}

function keyDefinition(name) {
  // Object.hasOwn: a plain `NAMED_KEYS[name]`/`KEY_ALIASES[...]` read matches inherited
  // Object.prototype names too ("toString", "constructor", "__proto__", "valueOf"),
  // resolving to a non-key value instead of reporting an unknown key.
  if (Object.hasOwn(NAMED_KEYS, name)) return NAMED_KEYS[name];
  const lower = name.toLowerCase();
  if (Object.hasOwn(KEY_ALIASES, lower)) return NAMED_KEYS[KEY_ALIASES[lower]];
  if (/^f([1-9]|1[0-2])$/i.test(name)) return NAMED_KEYS[name.toUpperCase()];
  if ([...name].length === 1) return charDefinition(name);
  return null;
}

const MOD_ALT = 1, MOD_CTRL = 2, MOD_META = 4, MOD_SHIFT = 8;

function parseKeyCombo(keyStr) {
  const parts = keyStr.split("+");
  let modifiers = 0;
  let def = null;
  parts.forEach((raw, i) => {
    const part = raw.trim();
    const lower = part.toLowerCase();
    const isLast = i === parts.length - 1;
    if (!isLast && (lower === "ctrl" || lower === "control")) modifiers |= MOD_CTRL;
    else if (!isLast && (lower === "alt" || lower === "option")) modifiers |= MOD_ALT;
    else if (!isLast && lower === "shift") modifiers |= MOD_SHIFT;
    else if (!isLast && ["meta", "cmd", "command", "win", "windows", "super"].includes(lower)) modifiers |= MOD_META;
    else if (isLast) def = keyDefinition(part);
    else throw new Error(`Unknown modifier: ${part}`);
  });
  if (!def) throw new Error(`Unknown key: ${keyStr}`);
  return { def, modifiers };
}

// macOS text fields ignore synthetic Cmd shortcuts unless the editing command is named.
const MAC_EDIT_COMMANDS = { a: "selectAll", c: "copy", x: "cut", v: "paste", z: "undo" };
const IS_MAC = typeof navigator !== "undefined" && /Mac/.test(navigator.platform || "");

async function pressKey(tabId, def, modifiers) {
  const shifted = (modifiers & MOD_SHIFT) !== 0 && /^[a-z]$/.test(def.key);
  const key = shifted ? def.key.toUpperCase() : def.key;
  const commandHeld = (modifiers & (MOD_CTRL | MOD_ALT | MOD_META)) !== 0;
  const text = commandHeld ? undefined : shifted ? key : def.text;
  const down = { type: text ? "keyDown" : "rawKeyDown", key, code: def.code, windowsVirtualKeyCode: def.keyCode, modifiers };
  if (text) down.text = text;
  // Look up by the letter's lowercase form: def.key is uppercase for a bare "A", so a
  // case-sensitive lookup would miss "cmd+A" even though "cmd+a" resolves it.
  const macKey = def.key.toLowerCase();
  if (IS_MAC && modifiers === MOD_META && Object.hasOwn(MAC_EDIT_COMMANDS, macKey)) down.commands = [MAC_EDIT_COMMANDS[macKey]];
  if (IS_MAC && modifiers === (MOD_META | MOD_SHIFT) && macKey === "z") down.commands = ["redo"];
  await cdp(tabId, "Input.dispatchKeyEvent", down);
  await cdp(tabId, "Input.dispatchKeyEvent", { type: "keyUp", key, code: def.code, windowsVirtualKeyCode: def.keyCode, modifiers });
}

// Whether the page's focused element accepts a literal line break: "multiline" for a
// <textarea> or a contenteditable element, "singleline" for an <input>, "unknown" when
// nothing editable is focused or a cross-origin iframe hides the real target.
const FOCUSED_FIELD_KIND_EXPR = `(() => {
  let el = document.activeElement;
  while (el) {
    if (el.shadowRoot && el.shadowRoot.activeElement) { el = el.shadowRoot.activeElement; continue; }
    if (el.tagName === "IFRAME") {
      let doc = null;
      try { doc = el.contentDocument; } catch (e) { doc = null; }
      if (!doc) return "unknown";
      el = doc.activeElement;
      continue;
    }
    break;
  }
  if (!el) return "unknown";
  // INPUT first: an <input> inside a contenteditable host, or in a designMode document,
  // reports isContentEditable true too, but it's still a single-line control.
  if (el.tagName === "INPUT") return "singleline";
  if (el.tagName === "TEXTAREA" || el.isContentEditable) return "multiline";
  return "unknown";
})()`;

async function focusedFieldKind(tabId, timeoutMs = 2000) {
  try {
    const result = await cdp(tabId, "Runtime.evaluate", { expression: FOCUSED_FIELD_KIND_EXPR, returnByValue: true }, timeoutMs);
    const value = result?.result?.value;
    return value === "multiline" || value === "singleline" ? value : "unknown";
  } catch {
    return "unknown";
  }
}

function parseModifierString(modStr) {
  if (!modStr) return 0;
  let modifiers = 0;
  const parts = modStr.split("+").map((p) => p.trim().toLowerCase());
  for (const part of parts) {
    if (part === "ctrl" || part === "control") modifiers |= 2;
    else if (part === "alt") modifiers |= 1;
    else if (part === "shift") modifiers |= 8;
    else if (part === "meta" || part === "cmd" || part === "command" || part === "win" || part === "windows") modifiers |= 4;
  }
  return modifiers;
}

// --- Content script communication ---
const CONTENT_MESSAGE_TIMEOUT_MS = 10000;

// A page that never answers used to hang forever: neither attempt below had any timeout of its
// own. Content.js answers every message synchronously, so a healthy page replies in
// milliseconds; a real 10s wait means the page is still loading, its main thread is busy, or
// (tabAccessError normally catches this first, but a dialog opened in the gap is still
// possible) it's frozen behind a JS dialog. The text below stays neutral about which.
async function sendContentMessage(tabId, message, timeoutMs = CONTENT_MESSAGE_TIMEOUT_MS) {
  const attempt = (async () => {
    try {
      return await chrome.tabs.sendMessage(tabId, message);
    } catch {
      // Content script might not be injected yet, try injecting
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ["content.js"],
      });
      // Retry
      return chrome.tabs.sendMessage(tabId, message);
    }
  })();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`The page did not respond within ${timeoutMs / 1000} s (it may be busy or showing a dialog). The action may still complete.`)), timeoutMs);
  });
  return Promise.race([attempt, timeout]).finally(() => clearTimeout(timer));
}

// --- Screenshot helper ---
// Cap viewport to 1280x800 for screenshots to keep size manageable.
// Retina displays produce 2x+ resolution PNGs that blow up base64 size.
const MAX_SCREENSHOT_WIDTH = 1280;
const MAX_SCREENSHOT_HEIGHT = 800;

async function takeScreenshot(tabId) {
  await ensureAttached(tabId);

  // With deviceScaleFactor: 1 set in ensureAttached, screenshots are captured
  // at CSS pixel dimensions (e.g., 1080x746), matching the coordinate space
  // used by Input.dispatchMouseEvent. No scaling tricks needed.
  const result = await cdp(tabId, "Page.captureScreenshot", {
    format: "jpeg",
    quality: 55,
    optimizeForSpeed: true,
    captureBeyondViewport: false,
  });
  let base64 = result.data;

  // If still too large (>500KB base64 ≈ ~375KB binary), reduce quality further
  if (base64.length > 500000) {
    const smaller = await cdp(tabId, "Page.captureScreenshot", {
      format: "jpeg",
      quality: 30,
      optimizeForSpeed: true,
      captureBeyondViewport: false,
    });
    base64 = smaller.data;
  }

  const imageId = `screenshot_${Date.now()}`;
  screenshotStore.set(imageId, base64);
  // Keep only last 10 screenshots (less memory pressure)
  const keys = Array.from(screenshotStore.keys());
  while (keys.length > 10) {
    screenshotStore.delete(keys.shift());
  }

  return { base64, imageId };
}

// --- Mouse helpers ---
async function dispatchMouse(tabId, type, x, y, opts = {}) {
  await cdp(tabId, "Input.dispatchMouseEvent", {
    type,
    x,
    y,
    button: opts.button || "left",
    clickCount: opts.clickCount || 1,
    modifiers: opts.modifiers || 0,
  });
}

async function mouseClick(tabId, x, y, opts = {}) {
  const button = opts.button || "left";
  const clickCount = opts.clickCount || 1;
  const modifiers = opts.modifiers || 0;

  await dispatchMouse(tabId, "mouseMoved", x, y, { modifiers });
  await sleep(50);
  await dispatchMouse(tabId, "mousePressed", x, y, { button, clickCount, modifiers });
  await sleep(50);
  await dispatchMouse(tabId, "mouseReleased", x, y, { button, clickCount, modifiers });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Formats a click/hover reply: the verb, where it landed, what it hit, whether a ref click had
// to scroll first, and any warnings (a covered target, an inert label) from getRefTarget or
// probePoint.
function pointerReply(verb, coordinate, hit, scrolled, notes) {
  let text = `${verb} at (${coordinate[0]}, ${coordinate[1]})`;
  if (hit) text += ` on ${hit}`;
  if (scrolled) text += " after scrolling it into view (take a new screenshot)";
  text += ".";
  if (notes.length) text += ` Warning: ${notes.join(" ")}`;
  return text;
}

// Runs a click dispatch, then replies normally — unless a JS dialog opened mid-dispatch (e.g. an
// onclick handler calling confirm()): the click itself already happened before the dialog
// interrupted whatever was left of it, so this says so instead of surfacing the raw internal
// error or waiting out a timeout for what a dialog has already frozen (rawCdp rejects those
// calls the moment the dialog opens, see DialogOpenedDuringCall).
async function dispatchPointerAction(verb, coordinate, hit, scrolled, notes, run) {
  try {
    await run();
  } catch (err) {
    if (err instanceof DialogOpenedDuringCall) {
      return `${verb}, and the page opened a JavaScript dialog ("${err.dialogMessage}"). It blocks the page until the user closes it.`;
    }
    throw err;
  }
  return pointerReply(verb, coordinate, hit, scrolled, notes);
}

// Normalizes a navigate URL, keeping explicit schemes intact instead of forcing everything
// through the http(s) rewrite. Returns { url } on success or { error } to report to the agent.
const NAVIGATE_SCHEME_RE = /^([a-z][a-z0-9+.-]*):/i;
const BROKEN_PROTOCOL_RE = /^[a-z]{1,5}:\/+/i;
const KEEP_AS_IS_SCHEMES = new Set([
  "http", "https", "file", "data", "about", "chrome", "brave", "edge",
  "view-source", "blob", "ftp", "chrome-extension",
]);
// view-source: and blob: can wrap another URL, and Chrome resolves that inner URL in the
// wrapper's own context — including the extension's own origin for a wrapped chrome-extension:
// URL, or the local filesystem for a wrapped file: URL — so callers unwrap before checking what
// they actually point at. An inner URL that fails to parse just stops the unwrap; it isn't an
// error by itself (the outer URL, e.g. view-source:https://..., is still valid). Refuses (returns
// null) past MAX_UNWRAPS layers instead of re-parsing an attacker-sized string once per layer,
// which is quadratic in the wrapper count.
const MAX_UNWRAPS = 4;
function unwrapViewSourceOrBlob(parsed) {
  let inner = parsed;
  let depth = 0;
  while (inner.protocol === "view-source:" || inner.protocol === "blob:") {
    if (depth >= MAX_UNWRAPS) return null;
    depth++;
    let next;
    try {
      next = new URL(inner.href.slice(inner.protocol.length));
    } catch {
      break;
    }
    inner = next;
  }
  return inner;
}

// True when `url` is (or unwraps, through nested view-source:/blob:, to) a file: URL or this
// extension's own chrome-extension: origin — the two kinds of page the agent is never allowed to
// act on, whether reached through navigate's own url argument (normalizeNavigateUrl below) or
// because a tab simply already shows one (tabAccessError above — e.g. after back/forward, or
// dragged into the group by hand).
function isBlockedUrl(url, ownExtensionId) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const inner = unwrapViewSourceOrBlob(parsed);
  if (inner === null) return true; // pathological nesting: treat as blocked rather than let it through
  // Node's URL parser leaves a non-special scheme's host case as-is, but Chrome lowercases it
  // when it canonicalizes a chrome-extension: URL, so compare against the lowercased host.
  // Chrome's parser also canonicalizes percent-encoded and extra-slash host variants to that
  // same host before this compare runs, so those are refused too in production — just not by
  // this in-process check alone, which is why own-page-refusal.test.mjs pins them via real Chrome.
  return inner.protocol === "file:" || (inner.protocol === "chrome-extension:" && inner.hostname.toLowerCase() === ownExtensionId);
}

function normalizeNavigateUrl(input, ownExtensionId) {
  let url = input.trim();
  const schemeMatch = url.match(NAVIGATE_SCHEME_RE);
  if (schemeMatch) {
    const scheme = schemeMatch[1].toLowerCase();
    if (scheme === "javascript") {
      return { error: "javascript: URLs are not allowed. Use javascript_tool to run code." };
    }
    if (!KEEP_AS_IS_SCHEMES.has(scheme)) {
      // Not a recognized scheme: either a broken protocol prefix (e.g. "hps://") to strip,
      // or a bare "host:port" to treat as the start of a URL.
      if (BROKEN_PROTOCOL_RE.test(url)) url = url.replace(BROKEN_PROTOCOL_RE, "");
      url = "https://" + url;
    }
  } else {
    url = "https://" + url;
  }

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { error: `Invalid URL: "${input}". Could not parse as a valid URL.` };
  }

  const inner = unwrapViewSourceOrBlob(parsed);
  if (inner === null) {
    return { error: "Too many nested view-source:/blob: wrappers." };
  }

  // Unpacked extensions get file: access by default, so this would otherwise let the agent
  // read any local file (navigate there, then get_page_text) regardless of the upload
  // allowlist.
  if (inner.protocol === "file:") {
    return { error: "file: URLs are blocked: the agent cannot open local files." };
  }

  // See isBlockedUrl above for the host-canonicalization caveat this compare relies on.
  if (inner.protocol === "chrome-extension:" && inner.hostname.toLowerCase() === ownExtensionId) {
    return { error: "This extension's own pages cannot be opened by the agent." };
  }

  return { url };
}

// --- Tool handlers ---

// A reply that reports a refusal or a failure. isError lets the MCP client, and browser_batch,
// tell it from a success without reading its text.
function errorResult(text) {
  return { content: [{ type: "text", text }], isError: true };
}

const toolHandlers = {
  async tabs_context_mcp(args) {
    await ensureTabGroup(args.createIfEmpty);
    if (tabGroupId === null) {
      return {
        content: [{ type: "text", text: "No MCP tab group exists. Use createIfEmpty: true to create one." }],
      };
    }
    const tabs = await chrome.tabs.query({ groupId: tabGroupId });
    return formatTabContext(tabs);
  },

  async tabs_create_mcp(args) {
    await ensureTabGroup(true);
    let groupTabs = await chrome.tabs.query({ groupId: tabGroupId });
    if (groupTabs.length === 0) {
      // The group's one tab could have closed in the gap since ensureTabGroup last checked
      // (Chrome auto-removes a group once its last tab is gone), leaving tabGroupId stale.
      // Retry once instead of falling back to a windowId-less tabs.create, which lands in the
      // operator's own window and then fails to group.
      await ensureTabGroup(true);
      groupTabs = await chrome.tabs.query({ groupId: tabGroupId });
      if (groupTabs.length === 0) {
        return errorResult("Could not create or find the MCP tab group.");
      }
    }
    // about:blank, not the default New Tab Page: that is a chrome:// page, which refuses the
    // debugger attach below.
    const tab = await chrome.tabs.create({ windowId: groupTabs[0].windowId, active: true, url: "about:blank" });
    await chrome.tabs.group({ tabIds: [tab.id], groupId: tabGroupId });
    tabGroupTabs.add(tab.id);
    // Attach the fresh tab now, not on whatever tool call happens to touch it first: a dialog
    // that opens before the tab is ever attached is never seen, and every CDP call then hangs
    // for the full 30s until the user closes it. Best-effort: tab creation must still work if
    // the attach fails.
    try { await ensureAttached(tab.id); } catch {}
    const tabs = await chrome.tabs.query({ groupId: tabGroupId });
    const result = formatTabContext(tabs);
    result.content[0].text = `Created new tab. Tab ID: ${tab.id}\n\n` + result.content[0].text;
    return result;
  },

  async tabs_close_mcp(args) {
    const { tabId } = args;
    const tabError = await tabAccessError(tabId, { allowBlockedUrl: true, allowDialog: true });
    if (tabError) return errorResult(tabError);
    // chrome.tabs.onRemoved cleans up our per-tab state (attached debugger,
    // console/network buffers). Chrome auto-removes the tab group when its last
    // tab is closed, so no extra group teardown is needed here.
    await chrome.tabs.remove(tabId);
    return { content: [{ type: "text", text: `Closed tab ${tabId}.` }] };
  },

  async navigate(args) {
    const { url, tabId } = args;
    const tabError = await tabAccessError(tabId, { allowDialog: true });
    if (tabError) return errorResult(tabError);

    // Attach before navigating, not after: otherwise a page that opens a dialog on load is
    // never seen, and every CDP call then hangs for the full 30s until the user closes it.
    // Best-effort: some pages (e.g. chrome://) refuse debugger attach outright, and navigate
    // must still work on those. The wait is bounded: a dialog this extension never saw can
    // freeze the tab, the attach then hangs, and navigating away is how the agent gets that
    // tab back. After the budget, the attach goes on in the background.
    let preAttachTimer;
    await Promise.race([
      ensureAttached(tabId).catch(() => {}),
      new Promise((resolve) => { preAttachTimer = setTimeout(resolve, PRE_ATTACH_BUDGET_MS); }),
    ]);
    clearTimeout(preAttachTimer);

    if (url === "back") {
      await chrome.tabs.goBack(tabId);
    } else if (url === "forward") {
      await chrome.tabs.goForward(tabId);
    } else {
      const normalized = normalizeNavigateUrl(url, chrome.runtime.id);
      if (normalized.error) {
        return errorResult(normalized.error);
      }
      try {
        await chrome.tabs.update(tabId, { url: normalized.url });
      } catch (err) {
        let message = err.message;
        if (!message.endsWith(".")) message += ".";
        return errorResult(`Could not navigate to ${normalized.url}: ${message}`);
      }
    }

    // Wait for page load — short timeout to avoid service worker idle kill
    // If the page takes longer, the caller can use screenshot/wait to check
    await new Promise((resolve) => {
      let timer;
      const listener = (updatedTabId, info) => {
        if (updatedTabId === tabId && info.status === "complete") {
          chrome.tabs.onUpdated.removeListener(listener);
          clearTimeout(timer);
          resolve();
        }
      };
      chrome.tabs.onUpdated.addListener(listener);
      // 10s max — enough for most pages, avoids service worker timeout
      timer = setTimeout(() => {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }, 10000);
    });

    // back/forward (unlike an explicit url, already refused above by normalizeNavigateUrl) can
    // land on a local file or this extension's own page — refuse instead of reporting its title.
    const tab = await chrome.tabs.get(tabId);
    if (isBlockedUrl(tab.url, chrome.runtime.id)) {
      return errorResult(`Tab ${tabId} shows a local file or this extension's own page, which the agent cannot use.`);
    }

    const tabs = await chrome.tabs.query({ groupId: tabGroupId });
    const loading = tab.status !== "complete" ? " (still loading)" : "";
    // Same (blocked) rule as tabs_context_mcp/formatTabContext: a *different* group tab can be
    // on a blocked page even when the one just navigated (checked above) isn't.
    const text = `Navigated to ${tab.url}${loading}.\n## Pages\n` +
      tabs.map((t, i) => `${i + 1}: ${isBlockedUrl(t.url, chrome.runtime.id) ? "(blocked)" : t.url}${t.id === tabId ? " [selected]" : ""}`).join("\n");

    return { content: [{ type: "text", text }] };
  },

  async computer(args) {
    const { action, tabId } = args;
    const tabError = await tabAccessError(tabId);
    if (tabError) return errorResult(tabError);

    let coordinate = args.coordinate;
    // Click actions and hover accept either a ref or a coordinate: a ref is resolved (and
    // scrolled into view if needed) by getRefTarget; a bare coordinate is only hit-tested by
    // probePoint, to name what it hits and to refuse one that's outside the viewport. scroll
    // and left_click_drag also accept a ref (restored below, resolved the same way as click
    // actions) but never a probed/refused coordinate, since neither is "clicking" a point the
    // way the actions above are. scroll_to has its own ref handling in its case below.
    const isPointerAction = ["left_click", "right_click", "double_click", "triple_click", "hover"].includes(action);
    const refResolvesToCoordinate = isPointerAction || action === "scroll" || action === "left_click_drag";
    let scrolled = false;
    let hit = "";
    let notes = [];
    if (refResolvesToCoordinate && args.ref && !coordinate) {
      const resp = await sendContentMessage(tabId, { type: "getRefTarget", ref: args.ref });
      const target = resp?.result;
      if (!target || target.error) return errorResult(target?.error || `Could not resolve ref "${args.ref}".`);
      coordinate = [target.x, target.y];
      // Captured regardless of action: left_click_drag needs to know a ref scroll happened
      // even though it doesn't report hit/notes the way a click does (see its case below).
      scrolled = target.scrolled;
      if (isPointerAction) {
        hit = target.hit;
        notes = target.notes;
      }
    } else if (isPointerAction && coordinate) {
      // A page where no content script can run at all (a certificate interstitial, a network
      // error page) never answers this message. Refuse only on an explicit "outside the
      // viewport" verdict; anything else (no content script, an old one without this handler)
      // falls through and the click still goes ahead, just without hit info.
      let probe = null;
      try {
        const resp = await sendContentMessage(tabId, { type: "probePoint", x: coordinate[0], y: coordinate[1] });
        probe = resp?.result;
      } catch {
        probe = null;
      }
      if (probe?.error) {
        return errorResult(probe.error);
      }
      if (probe?.inViewport === false) {
        return errorResult(`Coordinate (${coordinate[0]}, ${coordinate[1]}) is outside the viewport (${probe.viewport || ""}). Scroll first or use a ref.`);
      }
      if (probe) {
        hit = probe.hit;
        notes = probe.notes;
      }
    }

    const modifiers = parseModifierString(args.modifiers);

    switch (action) {
      case "screenshot": {
        const { base64, imageId } = await takeScreenshot(tabId);
        const vp = await readViewport(tabId);
        const dims = vp ? `${vp.width}x${vp.height}` : "";
        const image = { type: "image", data: base64, mimeType: "image/jpeg" };
        if (args.save_to_disk === true) image.saveToDisk = "screenshot";
        return {
          content: [
            { type: "text", text: `Successfully captured screenshot (${dims}, jpeg) - ID: ${imageId}.` },
            image,
          ],
        };
      }

      case "left_click": {
        if (!coordinate) return errorResult("coordinate is required for left_click");
        const text = await dispatchPointerAction("Clicked", coordinate, hit, scrolled, notes, () => mouseClick(tabId, coordinate[0], coordinate[1], { modifiers }));
        return { content: [{ type: "text", text }] };
      }

      case "right_click": {
        if (!coordinate) return errorResult("coordinate is required for right_click");
        const text = await dispatchPointerAction("Right-clicked", coordinate, hit, scrolled, notes, () => mouseClick(tabId, coordinate[0], coordinate[1], { button: "right", modifiers }));
        return { content: [{ type: "text", text }] };
      }

      case "double_click": {
        if (!coordinate) return errorResult("coordinate is required for double_click");
        const text = await dispatchPointerAction("Double-clicked", coordinate, hit, scrolled, notes, () => mouseClick(tabId, coordinate[0], coordinate[1], { clickCount: 2, modifiers }));
        return { content: [{ type: "text", text }] };
      }

      case "triple_click": {
        if (!coordinate) return errorResult("coordinate is required for triple_click");
        const text = await dispatchPointerAction("Triple-clicked", coordinate, hit, scrolled, notes, () => mouseClick(tabId, coordinate[0], coordinate[1], { clickCount: 3, modifiers }));
        return { content: [{ type: "text", text }] };
      }

      case "hover": {
        if (!coordinate) return errorResult("coordinate is required for hover");
        await dispatchMouse(tabId, "mouseMoved", coordinate[0], coordinate[1], { modifiers });
        await sleep(200);
        return { content: [{ type: "text", text: pointerReply("Hovered", coordinate, hit, scrolled, notes) }] };
      }

      case "type": {
        if (!args.text) return errorResult("text is required for type action");
        await ensureAttached(tabId);
        // "\r\n" and a lone "\r" both mean one line break. Per-character insertion of an
        // un-normalized "\r\n" would otherwise land as two in a multiline field.
        const text = args.text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
        let droppedNewline = false;
        let dropReason = null;
        for (const char of text) {
          if (char === "\n") {
            // Chrome's Input.insertText treats a "\n" in the inserted text as an implicit
            // Enter, submitting the form exactly like a real Enter keypress would, but only
            // when a single-line <input> is focused. A textarea or contenteditable just gets
            // a real line break. So it's only inserted where it's safe, checked fresh before
            // every "\n" (not once for the whole call) since a page's own input handler can
            // move focus between one line break and the next.
            const fieldKind = await focusedFieldKind(tabId);
            if (fieldKind === "multiline") await cdp(tabId, "Input.insertText", { text: "\n" });
            else { droppedNewline = true; dropReason = fieldKind; }
          } else {
            const def = charDefinition(char);
            if (def) await pressKey(tabId, def, def.shift ? MOD_SHIFT : 0);
            else await cdp(tabId, "Input.insertText", { text: char });
          }
          await sleep(10);
        }
        let reply = `Typed "${args.text.substring(0, 50)}${args.text.length > 50 ? "..." : ""}"`;
        if (droppedNewline) {
          reply += dropReason === "unknown"
            ? " (line breaks were not typed: could not be checked)"
            : " (line breaks were not typed: the focused field is single-line)";
        }
        return { content: [{ type: "text", text: reply }] };
      }

      case "key": {
        if (!args.text) return errorResult("text is required for key action");
        await ensureAttached(tabId);
        const repeat = Math.min(args.repeat || 1, 100);
        let combos;
        try {
          combos = args.text.split(" ").filter(Boolean).map(parseKeyCombo);
        } catch (err) {
          return errorResult(err.message);
        }
        for (let r = 0; r < repeat; r++) {
          for (const { def, modifiers: keyMods } of combos) {
            await pressKey(tabId, def, keyMods);
            await sleep(30);
          }
        }
        return { content: [{ type: "text", text: `Pressed ${repeat} key${repeat > 1 ? "s" : ""}: ${args.text}` }] };
      }

      case "scroll": {
        if (!coordinate) return errorResult("coordinate is required for scroll");
        const dir = args.scroll_direction || "down";
        const amount = Math.min(args.scroll_amount || 3, 10);
        const deltaX = dir === "left" ? -amount * 100 : dir === "right" ? amount * 100 : 0;
        const deltaY = dir === "up" ? -amount * 100 : dir === "down" ? amount * 100 : 0;
        await cdp(tabId, "Input.dispatchMouseEvent", {
          type: "mouseWheel",
          x: coordinate[0],
          y: coordinate[1],
          deltaX,
          deltaY,
          modifiers,
        });
        await sleep(300);
        const { base64 } = await takeScreenshot(tabId);
        return {
          content: [
            { type: "text", text: `Scrolled ${dir} by ${amount} ticks at (${coordinate[0]}, ${coordinate[1]})` },
            { type: "image", data: base64, mimeType: "image/jpeg" },
          ],
        };
      }

      case "scroll_to": {
        if (!coordinate && !args.ref) return errorResult("coordinate or ref is required for scroll_to");
        if (args.ref) {
          const resp = await sendContentMessage(tabId, { type: "scrollToRef", ref: args.ref });
          const target = resp?.result;
          if (!target || target.error) return errorResult(target?.error || `Could not resolve ref "${args.ref}".`);
          if (!target.inViewport) return errorResult(`Scrolled toward ${args.ref} but it is still outside the viewport at (${target.x}, ${target.y}).`);
          return { content: [{ type: "text", text: `Scrolled ${args.ref} into view at (${target.x}, ${target.y}).` }] };
        }
        await cdp(tabId, "Runtime.evaluate", { expression: `window.scrollTo(${coordinate[0]}, ${coordinate[1]})` });
        await sleep(300);
        return { content: [{ type: "text", text: `Scrolled the page to (${coordinate[0]}, ${coordinate[1]}).` }] };
      }

      case "wait": {
        const duration = Math.min(args.duration || 1, 30);
        await sleep(duration * 1000);
        return { content: [{ type: "text", text: `Waited for ${duration} second${duration !== 1 ? "s" : ""}` }] };
      }

      case "left_click_drag": {
        if (!args.start_coordinate || !coordinate) {
          return errorResult("start_coordinate and coordinate are required for left_click_drag");
        }
        // start_coordinate was read from a screenshot taken before resolving the ref. If that
        // resolution had to scroll the page, everything the caller saw (including
        // start_coordinate) is now stale — dragging from it would start in the wrong place.
        if (args.ref && scrolled) {
          return errorResult(`Scrolled ${args.ref} into view, so start_coordinate is stale. Take a new screenshot and retry the drag.`);
        }
        const [sx, sy] = args.start_coordinate;
        const [ex, ey] = coordinate;
        await dispatchMouse(tabId, "mouseMoved", sx, sy, { modifiers });
        await sleep(50);
        await dispatchMouse(tabId, "mousePressed", sx, sy, { button: "left", modifiers });
        await sleep(50);
        // Move in steps
        const steps = 10;
        for (let i = 1; i <= steps; i++) {
          const mx = sx + ((ex - sx) * i) / steps;
          const my = sy + ((ey - sy) * i) / steps;
          await dispatchMouse(tabId, "mouseMoved", mx, my, { modifiers });
          await sleep(20);
        }
        await dispatchMouse(tabId, "mouseReleased", ex, ey, { button: "left", modifiers });
        return { content: [{ type: "text", text: `Dragged from (${sx}, ${sy}) to (${ex}, ${ey})` }] };
      }

      case "zoom": {
        if (!args.region || args.region.length !== 4) {
          return errorResult("region [x0, y0, x1, y1] is required for zoom");
        }
        // Return the full screenshot with the region noted; the caller can crop
        // to it. Screenshots are JPEG (see takeScreenshot), so label them as such.
        const { base64: fullBase64 } = await takeScreenshot(tabId);
        const image = { type: "image", data: fullBase64, mimeType: "image/jpeg" };
        if (args.save_to_disk === true) image.saveToDisk = "zoom";
        return {
          content: [
            { type: "text", text: `Zoom region: [${args.region.join(", ")}]` },
            image,
          ],
        };
      }

      default:
        return errorResult(`Unknown computer action: ${action}`);
    }
  },

  async read_page(args) {
    const { tabId } = args;
    const tabError = await tabAccessError(tabId);
    if (tabError) return errorResult(tabError);

    const resp = await sendContentMessage(tabId, {
      type: "generateAccessibilityTree",
      options: {
        filter: args.filter,
        depth: args.depth,
        max_chars: args.max_chars,
        ref_id: args.ref_id,
      },
    });

    if (resp?.result?.error) return errorResult(resp.result.error);
    if (!resp?.result) return errorResult("Error: Could not generate accessibility tree");

    let tree = resp.result;
    // Append viewport dimensions so Claude knows the coordinate space
    const vp = await readViewport(tabId);
    if (vp) tree += `\n\nViewport: ${vp.width}x${vp.height}`;
    return { content: [{ type: "text", text: tree }] };
  },

  async get_page_text(args) {
    const { tabId } = args;
    const tabError = await tabAccessError(tabId);
    if (tabError) return errorResult(tabError);

    const resp = await sendContentMessage(tabId, { type: "getPageText" });
    if (resp?.result?.error) return errorResult(resp.result.error);
    if (!resp?.result) return errorResult("Error: Could not extract page text");

    try {
      const data = JSON.parse(resp.result);
      return {
        content: [
          {
            type: "text",
            text: `Title: ${data.title}\nURL: ${data.url}\nSource: <${data.sourceTag}>\n\n${data.text}`,
          },
        ],
      };
    } catch {
      return { content: [{ type: "text", text: resp.result }] };
    }
  },

  async find(args) {
    const { query, tabId } = args;
    const tabError = await tabAccessError(tabId);
    if (tabError) return errorResult(tabError);

    const resp = await sendContentMessage(tabId, { type: "findElements", query });
    if (resp?.result?.error) return errorResult(resp.result.error);
    const results = resp?.result || [];

    if (results.length === 0) {
      return { content: [{ type: "text", text: `No elements found matching "${query}"` }] };
    }

    let text = `Found ${results.length} element(s) matching "${query}":\n\n`;
    for (const r of results) {
      text += `[${r.ref}] ${r.role} "${r.name}" at (${r.coordinates[0]}, ${r.coordinates[1]})`;
      if (r.inViewport === false) text += " [off-screen, click by ref to scroll it into view]";
      text += "\n";
    }

    return { content: [{ type: "text", text }] };
  },

  async form_input(args) {
    const { ref, value, tabId } = args;
    const tabError = await tabAccessError(tabId);
    if (tabError) return errorResult(tabError);

    const resp = await sendContentMessage(tabId, { type: "setFormValue", ref, value });
    const result = resp?.result;

    if (result?.error) return errorResult(`Error: ${result.error}`);
    return { content: [{ type: "text", text: `Set ${ref} to "${value}". Result: ${JSON.stringify(result)}` }] };
  },

  async javascript_tool(args) {
    const { text, tabId } = args;
    const tabError = await tabAccessError(tabId);
    if (tabError) return errorResult(tabError);

    await ensureAttached(tabId);
    try {
      // Scripts may run up to the host's 60s per-request budget. Use a slightly shorter CDP
      // timeout so a hung script times out here with a clear message instead of the generic
      // host-level timeout.
      const result = await cdp(tabId, "Runtime.evaluate", {
        expression: text,
        returnByValue: true,
        awaitPromise: true,
      }, 55000);

      if (result.exceptionDetails) {
        return errorResult(`Error: ${result.exceptionDetails.text || JSON.stringify(result.exceptionDetails)}`);
      }

      const val = result.result;
      if (val.type === "undefined") return { content: [{ type: "text", text: "undefined" }] };
      return {
        content: [{ type: "text", text: val.value !== undefined ? JSON.stringify(val.value) : val.description || String(val) }],
      };
    } catch (e) {
      return errorResult(`Error: ${e.message}`);
    }
  },

  async read_console_messages(args) {
    const { tabId, pattern, limit = 100, onlyErrors, clear } = args;
    const tabError = await tabAccessError(tabId);
    if (tabError) return errorResult(tabError);

    // Ensure console domain is enabled
    await ensureAttached(tabId);
    await ensureDomain(tabId, "Console");
    await ensureDomain(tabId, "Runtime");

    let msgs = consoleMessages.get(tabId) || [];

    if (onlyErrors) {
      msgs = msgs.filter((m) => ["error", "exception"].includes(m.level));
    }

    if (pattern) {
      try {
        const re = new RegExp(pattern, "i");
        msgs = msgs.filter((m) => re.test(m.text) || re.test(m.level));
      } catch {
        // Invalid regex, use as substring
        msgs = msgs.filter((m) => m.text.includes(pattern));
      }
    }

    msgs = msgs.slice(-limit);

    if (clear) {
      consoleMessages.set(tabId, []);
    }

    if (msgs.length === 0) {
      return { content: [{ type: "text", text: "No console messages matching the pattern." }] };
    }

    const text = msgs
      .map((m) => `[${m.level}] ${m.text}${m.url ? ` (${m.url})` : ""}`)
      .join("\n");

    return { content: [{ type: "text", text: `Console messages (${msgs.length}):\n${text}` }] };
  },

  async read_network_requests(args) {
    const { tabId, urlPattern, limit = 100, clear } = args;
    const tabError = await tabAccessError(tabId);
    if (tabError) return errorResult(tabError);

    // Ensure network domain is enabled
    await ensureAttached(tabId);
    await ensureDomain(tabId, "Network");

    let reqs = networkRequests.get(tabId) || [];

    if (urlPattern) {
      reqs = reqs.filter((r) => r.url.includes(urlPattern));
    }

    reqs = reqs.slice(-limit);

    if (clear) {
      networkRequests.set(tabId, []);
    }

    if (reqs.length === 0) {
      return { content: [{ type: "text", text: "No network requests matching the pattern." }] };
    }

    const text = reqs
      .map((r) => `${r.method} ${r.url} ${r.status ? `→ ${r.status}` : "(pending)"}${r.mimeType ? ` [${r.mimeType}]` : ""}`)
      .join("\n");

    return { content: [{ type: "text", text: `Network requests (${reqs.length}):\n${text}` }] };
  },

  async resize_window(args) {
    const { width, height, tabId } = args;
    const tabError = await tabAccessError(tabId, { allowDialog: true });
    if (tabError) return errorResult(tabError);

    const tab = await chrome.tabs.get(tabId);
    const windowId = tab.windowId;

    // A maximized/fullscreen window ignores a width/height update, so un-maximize
    // first and wait for that to actually take effect before requesting the size.
    let win = await chrome.windows.get(windowId);
    if (win.state !== "normal") {
      await chrome.windows.update(windowId, { state: "normal" });
      for (let waited = 0; win.state !== "normal" && waited < 1000; waited += 50) {
        win = await chrome.windows.get(windowId);
        if (win.state !== "normal") await sleep(50);
      }
    }

    await chrome.windows.update(windowId, { width, height });

    // Wait for the page to reflow: poll until two consecutive viewport reads agree,
    // within a ~1s budget overall. Give each read only whatever budget is still
    // left (floored at 100ms), so a page that never answers Runtime.evaluate (e.g.
    // stuck on an open JS dialog) can't stall the reply anywhere near readViewport's
    // own default timeout, let alone cdp()'s full 30s.
    let elapsed = 0;
    let vp = await readViewport(tabId, Math.max(1000 - elapsed, 100));
    while (vp && elapsed < 1000) {
      await sleep(100);
      elapsed += 100;
      const next = await readViewport(tabId, Math.max(1000 - elapsed, 100));
      const stable = next && next.width === vp.width && next.height === vp.height;
      vp = next;
      if (stable) break;
    }

    win = await chrome.windows.get(windowId);
    let text = `Resized window to ${win.width}x${win.height}`;
    if (vp) text += ` (viewport ${vp.width}x${vp.height})`;
    text += ".";
    if (win.width !== width || win.height !== height) {
      text += ` Requested ${width}x${height}: the browser limited the size (screen size or minimum window size).`;
    }
    return { content: [{ type: "text", text }] };
  },

  // Run a sequence of tool actions in order and aggregate their content blocks
  // (text and images interleave naturally). Each action is { name, input } and
  // dispatches through the same toolHandlers map as a normal request. Stops at
  // the first action that throws or replies with isError, so nothing after a
  // failed step runs, and the batch's own reply then carries isError too.
  // Nested browser_batch is rejected.
  async browser_batch(args, ctx) {
    const actions = Array.isArray(args.actions) ? args.actions : [];
    if (actions.length === 0) {
      return errorResult("browser_batch requires a non-empty 'actions' array.");
    }

    const content = [];
    const fail = (text) => {
      content.push({ type: "text", text });
      return { content, isError: true };
    };
    for (let i = 0; i < actions.length; i++) {
      const name = actions[i]?.name;
      const input = actions[i]?.input || {};

      if (name === "browser_batch") return fail(`Action ${i + 1}: nested browser_batch is not allowed.`);
      const handler = toolHandlers[name];
      if (!handler) return fail(`Action ${i + 1}: unknown tool "${name}".`);

      content.push({ type: "text", text: `--- Action ${i + 1}/${actions.length}: ${name} ---` });
      let result;
      try {
        result = await handler(input, ctx);
      } catch (err) {
        return fail(`Action ${i + 1} (${name}) failed: ${err.message}`);
      }
      if (result?.content) content.push(...result.content);
      if (result?.isError) return fail(`Action ${i + 1} (${name}) failed, so the batch stopped.`);
    }

    return { content };
  },

  async upload_image(args) {
    const { imageId, ref, coordinate, filename, tabId } = args;
    const tabError = await tabAccessError(tabId);
    if (tabError) return errorResult(tabError);

    // Only screenshots captured by the computer tool this session are stored.
    // "user-uploaded" images have no equivalent here (no Claude.ai file channel).
    const base64 = screenshotStore.get(imageId);
    if (!base64) {
      return errorResult(`Image "${imageId}" not found. Only screenshots captured by the computer tool in this session can be uploaded.`);
    }

    // Best-effort: only the ref path (file input) is supported. The coordinate
    // drag & drop path (e.g. Google Docs) is not implemented in this fork.
    if (!ref) {
      return errorResult("upload_image requires a 'ref' to a file input in this extension. Coordinate-based drag & drop is not supported.");
    }

    // Stored screenshots are JPEG (see takeScreenshot). Set the File mime to
    // image/jpeg so it matches the actual bytes even if filename ends in .png.
    const resp = await sendContentMessage(tabId, {
      type: "uploadImage",
      ref,
      base64,
      filename: filename || "image.png",
      mimeType: "image/jpeg",
    });
    const result = resp?.result;
    if (!result || result.error) {
      return errorResult(`Error: ${result?.error || "image upload failed"}`);
    }
    return { content: [{ type: "text", text: `Uploaded image ${imageId} to ${ref} (${result.name}, ${result.size} bytes).` }] };
  },

  async file_upload(args) {
    const { paths, ref, tabId } = args;
    const tabError = await tabAccessError(tabId);
    if (tabError) return errorResult(tabError);
    if (!ref) return errorResult("file_upload requires a 'ref' to a file input.");
    if (!Array.isArray(paths) || paths.length === 0) {
      return errorResult("file_upload requires 'paths' to be a non-empty array of absolute file paths.");
    }

    // The host checks every path against the upload allowlist before a request
    // reaches the extension (host/upload-policy.js).
    await ensureAttached(tabId);

    // Mark the ref'd file input in the shared DOM so we can locate the same node
    // via CDP. (Works for light-DOM inputs; inputs buried in shadow DOM may not
    // be reachable by DOM.querySelector from the document root.)
    const mark = await sendContentMessage(tabId, { type: "markFileInput", ref });
    if (!mark?.result || mark.result.error) {
      return errorResult(`Error: ${mark?.result?.error || "could not resolve a file input for the ref"}`);
    }
    const token = mark.result.token;

    try {
      const doc = await cdp(tabId, "DOM.getDocument", { depth: 0 });
      const { nodeId } = await cdp(tabId, "DOM.querySelector", {
        nodeId: doc.root.nodeId,
        selector: `[data-mcp-file-input="${token}"]`,
      });
      if (!nodeId) {
        return errorResult("Error: could not locate the file input node via CDP (it may be inside shadow DOM).");
      }
      await cdp(tabId, "DOM.setFileInputFiles", { nodeId, files: paths });
    } finally {
      await sendContentMessage(tabId, { type: "unmarkFileInput", ref }).catch(() => {});
    }

    return { content: [{ type: "text", text: `Uploaded ${paths.length} file(s) to ${ref}: ${paths.join(", ")}` }] };
  },

  async gif_creator(args) {
    return { content: [{ type: "text", text: "GIF recording is not yet implemented in this extension." }] };
  },

  async shortcuts_list(args) {
    return { content: [{ type: "text", text: "No shortcuts available. Shortcuts are not supported in this extension." }] };
  },

  async shortcuts_execute(args) {
    return { content: [{ type: "text", text: "Shortcuts are not supported in this extension." }] };
  },

  async switch_browser(args) {
    return { content: [{ type: "text", text: "Browser switching is not yet supported. The extension connects to whichever browser has it loaded (Chrome, Brave, or Edge). To switch, disable the extension in the current browser, enable it in the target browser, and restart both." }] };
  },

  async list_connected_browsers(args) {
    // Honest stub: this fork uses Chrome native messaging with one host per
    // browser and no shared account relay, so there is no multi-browser
    // registry (deviceIds) to enumerate.
    return { content: [{ type: "text", text: "Listing connected browsers is not supported in this extension. It uses native messaging with a single browser per host, so there is no multi-browser registry to enumerate." }] };
  },

  async select_browser(args) {
    // Honest stub: no deviceId registry exists (see list_connected_browsers).
    return { content: [{ type: "text", text: "Selecting a browser by deviceId is not supported in this extension. The native-messaging host connects to whichever single browser has the extension loaded." }] };
  },

};

// Wrap once, in place, so browser_batch's own toolHandlers[name] lookups reach the
// wrapped nested handlers too. Keeps exactly the same 22 keys, just new function values.
Audit.wrapHandlers(toolHandlers);

// --- Tool dispatch ---
async function handleToolRequest(id, tool, args, session) {
  const handler = toolHandlers[tool];
  if (!handler) {
    sendError(id, `Unknown tool: ${tool}`);
    return;
  }

  const ctx = { session, requestId: id };
  try {
    const result = await handler(args, ctx);
    sendResponse(id, result);
  } catch (err) {
    sendError(id, `${tool} failed: ${err.message}`);
  }
}

// --- Audit: recorder events relayed from the in-page recorder ---
// Sender-derived tabId (not a field in msg): a content script can't spoof another
// tab's id, and onRecorderEvents itself drops events for a tab with no owner.
// sender.id must match our own extension id and sender.tab must be set, so only our
// injected recorder.js — not some other message — reaches Audit.onRecorderEvents.
// sender.id is always our own for anything reaching onMessage (no
// externally_connectable in the manifest), so on its own it is a weak gate — this
// extension's own pages (e.g. options.html opened in a tab) pass it and
// sender.tab too. frameId must be the top frame (injection always targets frame
// 0), and origin must not be one of the extension's own pages.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (
    msg && msg.type === "ocic_audit_events" &&
    sender.id === chrome.runtime.id &&
    sender.tab &&
    sender.frameId === 0 &&
    sender.origin !== `chrome-extension://${chrome.runtime.id}`
  ) {
    Audit.onRecorderEvents(sender.tab.id, msg.events || []);
    sendResponse({ ok: true });
  }
});

// --- Init ---

// Recover MCP tab group state after service worker restart
async function recoverTabGroupState() {
  try {
    const groups = await chrome.tabGroups.query({ title: "MCP" });
    if (groups.length > 0) {
      tabGroupId = groups[0].id;
      const tabs = await chrome.tabs.query({ groupId: tabGroupId });
      tabGroupTabs = new Set(tabs.map((t) => t.id));
    }
  } catch {
    // Not critical — will be set on first tabs_context_mcp call
  }
}

recoverTabGroupState();
connectNativeHost();
// Audit records only tabs the tools may use, but an open JS dialog must not
// stop a tab's recording, so the dialog state is ignored here.
Audit.init({ store: AuditStore, isTabAllowed: async (tabId) => (await tabAccessError(tabId, { allowDialog: true })) === null });
