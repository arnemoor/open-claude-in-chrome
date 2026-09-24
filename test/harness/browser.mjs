// Isolated headless Chrome for tests: a fresh profile under /tmp, never the user's browser.
import { spawn } from "node:child_process";
import fs from "node:fs";

export const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
export const chromeAvailable = fs.existsSync(CHROME);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function launchChrome({ args = [] } = {}) {
  const profile = fs.mkdtempSync("/tmp/ocic-chrome-");
  const proc = spawn(CHROME, [
    "--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`,
    "--no-first-run", "--no-default-browser-check", "--disable-extensions",
    "--disable-background-networking", "--disable-sync", "--window-size=1200,800",
    ...args, "about:blank",
  ], { stdio: "ignore" });
  let ws;
  try {
    const portFile = `${profile}/DevToolsActivePort`;
    for (let i = 0; i < 150 && !fs.existsSync(portFile); i++) await sleep(100);
    const [port, wsPath] = fs.readFileSync(portFile, "utf8").trim().split("\n");
    ws = new WebSocket(`ws://127.0.0.1:${port}${wsPath}`);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  } catch (err) {
    try { proc.kill("SIGKILL"); } catch {}
    try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch {}
    throw err;
  }
  let seq = 0;
  const pending = new Map();
  const listeners = new Set();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    } else if (msg.method) {
      for (const l of listeners) l(msg);
    }
  };
  // A crashed/killed browser closes the socket without ever answering in-flight sends.
  // Reject them instead of leaving those callers hanging forever.
  ws.onclose = () => {
    for (const { reject } of pending.values()) reject(new Error("Chrome connection closed"));
    pending.clear();
  };
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  let closed = null;
  const close = () => {
    if (!closed) {
      closed = (async () => {
        try { ws.close(); } catch {}
        try { proc.kill("SIGKILL"); } catch {}
        if (proc.exitCode === null && proc.signalCode === null) {
          await new Promise((resolve) => proc.once("exit", resolve));
        }
        try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch {}
      })();
    }
    return closed;
  };
  return { send, onEvent: (fn) => { listeners.add(fn); return () => listeners.delete(fn); }, close, profile };
}

export async function evaluate(send, expression, contextId) {
  const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true, ...(contextId ? { contextId } : {}) });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
}

export async function navigate(page, url) {
  const loaded = new Promise((res) => {
    const off = page.browser.onEvent((m) => {
      if (m.sessionId === page.sessionId && m.method === "Page.loadEventFired") { off(); res(); }
    });
  });
  await page.send("Page.navigate", { url });
  await Promise.race([loaded, sleep(5000)]);
}

export async function openPage(browser, { html, url } = {}) {
  const { targetId } = await browser.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await browser.send("Target.attachToTarget", { targetId, flatten: true });
  const send = (method, params) => browser.send(method, params, sessionId);
  await send("Page.enable");
  await send("Runtime.enable");
  const page = { targetId, sessionId, send, browser, evaluate: (expr) => evaluate(send, expr) };
  if (html || url) await navigate(page, url || `data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  return page;
}

// Run extension/content.js in an isolated world, the way Chrome runs content scripts,
// with a stub chrome.runtime that captures its message listener.
export async function injectContentScript(page, contentJsPath) {
  const { frameTree } = await page.send("Page.getFrameTree");
  const { executionContextId } = await page.send("Page.createIsolatedWorld", { frameId: frameTree.frame.id, worldName: "ocic-content" });
  await evaluate(page.send, "globalThis.chrome = { runtime: { id: 'testextensionid', onMessage: { addListener(fn) { globalThis.__ocicListener = fn; } }, sendMessage() {} } };", executionContextId);
  await evaluate(page.send, fs.readFileSync(contentJsPath, "utf8"), executionContextId);
  const invoke = (message) => evaluate(page.send,
    `new Promise((resolve) => { const keep = globalThis.__ocicListener(${JSON.stringify(message)}, { id: "testextensionid" }, resolve); if (keep !== true) resolve(undefined); })`,
    executionContextId);
  return { invoke, contextId: executionContextId };
}

export function jpegSize(base64) {
  const b = Buffer.from(base64, "base64");
  for (let i = 2; i < b.length - 9; ) {
    if (b[i] !== 0xff) { i++; continue; }
    const marker = b[i + 1];
    if (marker >= 0xc0 && marker <= 0xc3) return [b.readUInt16BE(i + 7), b.readUInt16BE(i + 5)];
    i += 2 + b.readUInt16BE(i + 2);
  }
  throw new Error("no SOF marker");
}
