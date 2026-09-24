import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { BridgeClient, NOT_CONNECTED, LOST } from "../bridge-client.js";
import { bridgePath, bridgeDir, prepareBridgeDir } from "../bridge-endpoint.js";
import { tmpHome, startHub, waitFor, sleep } from "./helpers.mjs";

const client = (home, opts = {}) => {
  const c = new BridgeClient({ sockPath: bridgePath(home), hello: { pid: process.pid, ppid: process.ppid, cwd: "/w/x", label: "x" }, retryMinMs: 20, retryMaxMs: 100, ...opts });
  c.start();
  return c;
};

test("request round trip", { timeout: 10000 }, async (t) => {
  const home = tmpHome();
  const { hub, ext } = await startHub(home);
  t.after(() => hub.stop("cleanup").catch(() => {}));
  const c = client(home);
  t.after(() => c.close());
  const p = c.request("find", { query: "q", tabId: 1 });
  await waitFor(() => ext.received.length === 1);
  ext.reply(ext.received[0], { content: [] });
  assert.deepEqual(await p, { content: [] });
  c.close(); await hub.stop("test");
});

test("a call made while the hub is starting waits for it (grace)", { timeout: 10000 }, async (t) => {
  const home = tmpHome();
  const c = client(home, { graceMs: 2000 });
  t.after(() => c.close());
  const p = c.request("find", {});
  await sleep(300);
  const { hub, ext } = await startHub(home);
  t.after(() => hub.stop("cleanup").catch(() => {}));
  await waitFor(() => ext.received.length === 1);
  ext.reply(ext.received[0], "ok");
  assert.equal(await p, "ok");
  c.close(); await hub.stop("test");
});

test("no hub within grace: fails fast with an actionable message", { timeout: 10000 }, async (t) => {
  const home = tmpHome();
  const c = client(home, { graceMs: 300 });
  t.after(() => c.close());
  const t0 = Date.now();
  await assert.rejects(c.request("find", {}), (e) => e.message === NOT_CONNECTED);
  assert.ok(Date.now() - t0 < 1000);
  c.close();
});

test("a written request that loses the hub fails with LOST and is never resent", { timeout: 10000 }, async (t) => {
  const home = tmpHome();
  const first = await startHub(home);
  t.after(() => first.hub.stop("cleanup").catch(() => {}));
  const c = client(home);
  t.after(() => c.close());
  const p = c.request("computer", { action: "left_click", coordinate: [1, 1], tabId: 1 });
  await waitFor(() => first.ext.received.length === 1);
  await first.hub.stop("browser restart");
  await assert.rejects(p, (e) => e.message === LOST);
  const second = await startHub(home);
  t.after(() => second.hub.stop("cleanup").catch(() => {}));
  await waitFor(() => c.connected, 2000);
  await sleep(300);
  assert.equal(second.ext.received.length, 0, "nothing may be replayed to the new hub");
  c.close(); await second.hub.stop("test");
});

test("fifteen clients survive a hub restart: one LOST each, no replay, all reconnect", { timeout: 15000 }, async (t) => {
  const home = tmpHome();
  const first = await startHub(home);
  t.after(() => first.hub.stop("cleanup").catch(() => {}));
  const clients = Array.from({ length: 15 }, () => client(home));
  t.after(() => { for (const c of clients) c.close(); });
  const outcomes = clients.map((c, i) => c.request("computer", { action: "type", text: `t${i}`, tabId: 1 }).then(() => "ok", (e) => e.message));
  await waitFor(() => first.ext.received.length === 15);
  await first.hub.stop("browser restart");
  assert.deepEqual(await Promise.all(outcomes), Array(15).fill(LOST));
  const second = await startHub(home);
  t.after(() => second.hub.stop("cleanup").catch(() => {}));
  await waitFor(() => clients.every((c) => c.connected), 3000);
  await sleep(200);
  assert.equal(second.ext.received.length, 0);
  for (const c of clients) c.close();
  await second.hub.stop("test");
});

test("refuses to connect through an unsafe directory", { timeout: 10000 }, async (t) => {
  const home = tmpHome();
  const { hub } = await startHub(home);
  t.after(() => hub.stop("cleanup").catch(() => {}));
  fs.chmodSync(bridgeDir(home), 0o755);
  t.after(() => { try { fs.chmodSync(bridgeDir(home), 0o700); } catch {} });
  const c = client(home, { graceMs: 300 });
  t.after(() => c.close());
  await assert.rejects(c.request("find", {}), (e) => e.message.startsWith(NOT_CONNECTED) && e.message.includes("Refusing to connect"));
  c.close(); fs.chmodSync(bridgeDir(home), 0o700); await hub.stop("test");
});

test("per-request timeout", { timeout: 10000 }, async (t) => {
  const home = tmpHome();
  const { hub } = await startHub(home);
  t.after(() => hub.stop("cleanup").catch(() => {}));
  const c = client(home, { requestTimeoutMs: 300 });
  t.after(() => c.close());
  await assert.rejects(c.request("find", {}), (e) => e.message === "Tool request timed out after 0.3s");
  c.close(); await hub.stop("test");
});

// --- Fix round: M6 -----------------------------------------------------------

test("a grace-timeout rejection drops its waiter instead of leaking it until the next welcome", { timeout: 10000 }, async (t) => {
  const home = tmpHome();
  const c = client(home, { graceMs: 100 });
  t.after(() => c.close());
  await assert.rejects(c.request("javascript_tool", { text: "x".repeat(1000) }), (e) => e.message === NOT_CONNECTED);
  assert.equal(c._connectWaiters.length, 0, "the timed-out request's waiter must not remain queued");
});
