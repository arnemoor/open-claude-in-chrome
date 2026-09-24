import fs from "node:fs";
import { BridgeHub } from "../bridge-hub.js";
import { bridgePath } from "../bridge-endpoint.js";

// Every temp dir any test creates through mkdtemp()/tmpHome() is tracked here
// so one cleanupTmpDirs() call (registered once per test file via node:test's
// after()) can remove them all. /tmp stays the base rather than os.tmpdir():
// the bridge socket path must fit under the platform's sun_path limit.
const createdTmpDirs = [];

export function mkdtemp(prefix = "/tmp/ocic-") {
  const dir = fs.mkdtempSync(prefix);
  createdTmpDirs.push(dir);
  return dir;
}

export const tmpHome = () => mkdtemp();

export function cleanupTmpDirs() {
  for (const dir of createdTmpDirs.splice(0)) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function waitFor(pred, timeoutMs = 3000, stepMs = 20) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await pred()) return true;
    await sleep(stepMs);
  }
  throw new Error("waitFor timed out");
}

// A stand-in for the browser extension: records every request the hub forwards.
export function fakeExtension() {
  const received = [];
  let hub = null;
  return {
    received,
    attach(h) { hub = h; },
    send: (msg) => received.push(msg),
    reply(msg, result) { hub.handleExtensionMessage({ type: "tool_response", id: msg.id, result }); },
    fail(msg, error) { hub.handleExtensionMessage({ type: "tool_error", id: msg.id, error }); },
  };
}

export async function startHub(home, opts = {}) {
  const ext = fakeExtension();
  const hub = new BridgeHub({ sockPath: bridgePath(home), sendToExtension: ext.send, ...opts });
  ext.attach(hub);
  const state = await hub.start();
  return { hub, ext, state };
}
