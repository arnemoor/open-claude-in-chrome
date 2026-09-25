// Loads extension/background.js into a vm context with a fake chrome.* API, so tool
// handlers can be tested without installing the extension.
//   page:    a page from browser.mjs. chrome.debugger commands then run on that real
//            page, and CDP events from it reach chrome.debugger.onEvent.
//   content: the object returned by injectContentScript(page). chrome.tabs.sendMessage
//            then reaches the real content.js in that page.
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const EXT = path.join(import.meta.dirname, "..", "..", "extension");

export function event() {
  const ls = [];
  return {
    addListener: (f) => ls.push(f),
    removeListener: (f) => { const i = ls.indexOf(f); if (i >= 0) ls.splice(i, 1); },
    hasListener: (f) => ls.includes(f),
    fire: (...a) => ls.forEach((f) => f(...a)),
    listeners: ls,
  };
}

function memoryArea(initial = {}) {
  const data = { ...initial };
  return {
    data,
    get: async (keys) => {
      if (keys == null) return { ...data };
      const list = typeof keys === "string" ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
      const out = {};
      for (const k of list) if (k in data) out[k] = data[k];
      return out;
    },
    set: async (items) => { Object.assign(data, items); },
    remove: async (keys) => { for (const k of [].concat(keys)) delete data[k]; },
  };
}

function deepAssign(target, src) {
  for (const [k, v] of Object.entries(src)) {
    if (v && typeof v === "object" && !Array.isArray(v) && typeof target[k] === "object") deepAssign(target[k], v);
    else target[k] = v;
  }
}

export async function loadBackground({ page = null, content = null, tab = {}, window = {}, overrides = {}, beforeRun = null } = {}) {
  const calls = [];
  const posted = [];
  const TAB_ID = tab.id ?? 11;
  const WINDOW_ID = window.id ?? 1;
  const GROUP_ID = 7;
  const attached = new Set();
  const chrome = {
    alarms: { create: (name, opts) => { calls.push(["alarms.create", name, opts]); }, clear: async () => true, onAlarm: event() },
    runtime: {
      id: "testextensionid",
      lastError: null,
      onMessage: event(),
      connectNative: () => {
        const port = { onMessage: event(), onDisconnect: event(), postMessage: (m) => posted.push(m) };
        chrome.__port = port;
        return port;
      },
    },
    tabs: {
      get: async (id) => ({ id, windowId: WINDOW_ID, groupId: GROUP_ID, status: "complete", url: "https://example.test/", ...tab }),
      query: async () => [{ id: TAB_ID, windowId: WINDOW_ID, groupId: GROUP_ID, title: "t", url: "https://example.test/" }],
      create: async (p) => { calls.push(["tabs.create", p]); return { id: 12, windowId: p.windowId ?? 99 }; },
      group: async (p) => { calls.push(["tabs.group", p]); return GROUP_ID; },
      update: async (...a) => { calls.push(["tabs.update", ...a]); return { id: a[0] }; },
      remove: async (id) => { calls.push(["tabs.remove", id]); },
      goBack: async () => {},
      goForward: async () => {},
      onRemoved: event(),
      onUpdated: event(),
      sendMessage: async (tabId, msg) => {
        calls.push(["tabs.sendMessage", msg.type]);
        if (content) return content.invoke(msg);
        throw new Error("The message port closed before a response was received.");
      },
    },
    tabGroups: { get: async (id) => ({ id, title: "MCP" }), query: async () => [{ id: GROUP_ID, title: "MCP" }], update: async () => {}, onRemoved: event(), onCreated: event() },
    windows: {
      get: async (id) => ({ id, width: 1200, height: 800, state: "normal", ...window }),
      create: async (p) => { calls.push(["windows.create", p]); return { id: WINDOW_ID, tabs: [{ id: TAB_ID }] }; },
      update: async (...a) => { calls.push(["windows.update", ...a]); },
    },
    debugger: {
      attach: async ({ tabId }) => {
        calls.push(["debugger.attach", tabId]);
        await new Promise((r) => setTimeout(r, 20));
        if (attached.has(tabId)) throw new Error(`Another debugger is already attached to the tab with id: ${tabId}.`);
        attached.add(tabId);
      },
      detach: async ({ tabId }) => { calls.push(["debugger.detach", tabId]); attached.delete(tabId); },
      sendCommand: async (target, method, params) => {
        calls.push(["cdp", method, params]);
        if (page) return page.send(method, params);
        if (method === "Runtime.evaluate") return { result: { value: [1200, 713] } };
        if (method === "Page.captureScreenshot") return { data: "AAAA" };
        return {};
      },
      onDetach: event(),
      onEvent: event(),
    },
    scripting: { executeScript: async (p) => { calls.push(["scripting.executeScript", p]); return []; } },
    // Group 7 is the one this extension created before the worker started: background.js adopts
    // a group only by the id it stored in session storage.
    storage: { local: memoryArea(), session: memoryArea({ mcpTabGroupId: GROUP_ID }), onChanged: event() },
  };
  deepAssign(chrome, overrides);
  if (page) {
    page.browser.onEvent((m) => {
      if (m.sessionId === page.sessionId) chrome.debugger.onEvent.fire({ tabId: TAB_ID }, m.method, m.params);
    });
  }
  const ctx = vm.createContext({
    chrome, console, setTimeout, clearTimeout, setInterval, clearInterval, URL,
    TextEncoder, TextDecoder, atob, btoa, structuredClone, crypto: globalThis.crypto,
    self: { addEventListener() {} },
    navigator: { platform: process.platform === "darwin" ? "MacIntel" : "Linux x86_64", userAgent: "node" },
  });
  ctx.importScripts = (...files) => {
    for (const f of files) vm.runInContext(fs.readFileSync(path.join(EXT, f), "utf8"), ctx, { filename: f });
  };
  if (beforeRun) beforeRun(ctx);
  vm.runInContext(fs.readFileSync(path.join(EXT, "background.js"), "utf8"), ctx, { filename: "background.js" });
  const get = (expr) => vm.runInContext(expr, ctx);
  return { chrome, calls, posted, get, handlers: get("toolHandlers"), tabId: TAB_ID, deliver: (msg) => chrome.__port.onMessage.fire(msg) };
}
