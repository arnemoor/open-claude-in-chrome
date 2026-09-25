import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { BridgeClient } from "../bridge-client.js";
import { bridgeDir, bridgePath } from "../bridge-endpoint.js";
import { tmpHome, waitFor, sleep, cleanupTmpDirs } from "./helpers.mjs";

after(cleanupTmpDirs);

const HOST = path.join(import.meta.dirname, "..", "native-host.js");
const frame = (obj) => { const b = Buffer.from(JSON.stringify(obj)); const h = Buffer.alloc(4); h.writeUInt32LE(b.length); return Buffer.concat([h, b]); };

function spawnHost(home, extraEnv = {}) {
  const proc = spawn(process.execPath, [HOST], { env: { ...process.env, HOME: home, ...extraEnv }, stdio: ["pipe", "pipe", "pipe"] });
  const frames = [];
  let buf = Buffer.alloc(0);
  let garbage = false;
  proc.stdout.on("data", (d) => {
    buf = Buffer.concat([buf, d]);
    while (buf.length >= 4) {
      const len = buf.readUInt32LE(0);
      if (len > 64 * 1024 * 1024) { garbage = true; return; }
      if (buf.length < 4 + len) break;
      try { frames.push(JSON.parse(buf.subarray(4, 4 + len).toString())); } catch { garbage = true; }
      buf = buf.subarray(4 + len);
    }
  });
  return { proc, frames, isClean: () => !garbage && buf.length === 0 };
}

test("relays a client request to the extension and the reply back", { timeout: 15000 }, async (t) => {
  const home = tmpHome();
  const h = spawnHost(home);
  t.after(() => { try { h.proc.kill("SIGKILL"); } catch {} });
  await waitFor(() => fs.existsSync(bridgePath(home)));
  const c = new BridgeClient({ sockPath: bridgePath(home), hello: { pid: 1, ppid: 1, cwd: "/w/p", label: "p" }, retryMinMs: 20 });
  t.after(() => c.close());
  c.start();
  const p = c.request("get_page_text", { tabId: 5 });
  await waitFor(() => h.frames.length === 1);
  assert.equal(h.frames[0].tool, "get_page_text");
  assert.equal(h.frames[0].session.label, "p");
  h.proc.stdin.write(frame({ type: "tool_response", id: h.frames[0].id, result: "text" }));
  assert.equal(await p, "text");
  assert.ok(h.isClean(), "stdout carries only native-messaging frames");
  c.close();
  h.proc.kill("SIGTERM");
});

test("exits when the extension disconnects and removes its socket", { timeout: 15000 }, async (t) => {
  const home = tmpHome();
  const h = spawnHost(home);
  t.after(() => { try { h.proc.kill("SIGKILL"); } catch {} });
  await waitFor(() => fs.existsSync(bridgePath(home)));
  const exited = new Promise((r) => h.proc.once("exit", (code) => r(code)));
  h.proc.stdin.end();
  assert.equal(await exited, 0);
  assert.ok(!fs.existsSync(bridgePath(home)));
});

// --- Fix round: M2 -----------------------------------------------------------

test("a start failure that is not a BridgeSecurityError still retries instead of exiting", { timeout: 15000 }, async (t) => {
  const home = tmpHome();
  const dir = bridgeDir(home);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const sockPath = bridgePath(home);
  // A real listening socket, then locked to mode 0: connecting to it fails
  // with a raw EACCES, not the BridgeSecurityError the old code special-cased
  // (every failure inside prepareBridgeDir/verifyBridgeDir is already wrapped
  // in one, so this is how a genuinely different failure looks in practice).
  const blocker = net.createServer(() => {});
  t.after(() => { try { blocker.close(); } catch {} });
  await new Promise((r) => blocker.listen(sockPath, r));
  fs.chmodSync(sockPath, 0o000);

  const h = spawnHost(home, { OCIC_START_RETRY_MS: "150" });
  t.after(() => { try { h.proc.kill("SIGKILL"); } catch {} });
  let stderr = "";
  h.proc.stderr.on("data", (d) => { stderr += d; });

  await waitFor(() => /start_failed/.test(stderr));
  await sleep(500); // several 150 ms retries against the same locked-down socket
  assert.equal((stderr.match(/start_failed/g) || []).length, 1, "one distinct cause logs once despite repeated retries");
  assert.equal(h.proc.exitCode, null, "must not have exited");
  assert.match(stderr, /EACCES/);

  await new Promise((r) => blocker.close(r));
  try { fs.unlinkSync(sockPath); } catch {}

  await waitFor(() => fs.existsSync(sockPath), 5000);
  const c = new BridgeClient({ sockPath, hello: { pid: 1, ppid: 1, cwd: "/w/p", label: "p" }, retryMinMs: 20 });
  t.after(() => c.close());
  c.start();
  const p = c.request("get_page_text", { tabId: 1 });
  await waitFor(() => h.frames.length === 1);
  h.proc.stdin.write(frame({ type: "tool_response", id: h.frames[0].id, result: "recovered" }));
  assert.equal(await p, "recovered");
  c.close();
});
