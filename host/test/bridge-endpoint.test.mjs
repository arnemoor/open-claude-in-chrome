import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import {
  bridgeDir, bridgePath, prepareBridgeDir, verifyBridgeDir,
  verifySocketOwner, assertSocketPathFits, BridgeSecurityError,
} from "../bridge-endpoint.js";

const tmpHome = () => fs.mkdtempSync("/tmp/ocic-");
const mode = (p) => fs.lstatSync(p).mode & 0o777;

test("paths derive from HOME", () => {
  assert.equal(bridgeDir("/Users/x"), "/Users/x/.config/open-claude-in-chrome/run");
  assert.equal(bridgePath("/Users/x"), "/Users/x/.config/open-claude-in-chrome/run/bridge.sock");
});

test("prepareBridgeDir creates a 0700 directory", () => {
  const dir = bridgeDir(tmpHome());
  prepareBridgeDir(dir);
  assert.equal(mode(dir), 0o700);
});

test("prepareBridgeDir tightens an existing directory we own", () => {
  const dir = bridgeDir(tmpHome());
  fs.mkdirSync(dir, { recursive: true });
  fs.chmodSync(dir, 0o755);
  prepareBridgeDir(dir);
  assert.equal(mode(dir), 0o700);
});

test("a symlinked directory is refused", () => {
  const home = tmpHome();
  const real = path.join(home, "real");
  fs.mkdirSync(real, { mode: 0o700 });
  const dir = bridgeDir(home);
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  fs.symlinkSync(real, dir);
  assert.throws(() => prepareBridgeDir(dir), BridgeSecurityError);
  assert.throws(() => verifyBridgeDir(dir), BridgeSecurityError);
});

test("a regular file at the directory path is refused", () => {
  const dir = bridgeDir(tmpHome());
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  fs.writeFileSync(dir, "x");
  assert.throws(() => prepareBridgeDir(dir), BridgeSecurityError);
});

test("verifyBridgeDir refuses group/other bits and foreign owners, never fixes", () => {
  const dir = bridgeDir(tmpHome());
  prepareBridgeDir(dir);
  fs.chmodSync(dir, 0o750);
  assert.throws(() => verifyBridgeDir(dir), BridgeSecurityError);
  assert.equal(mode(dir), 0o750);
  fs.chmodSync(dir, 0o700);
  assert.throws(() => verifyBridgeDir(dir, { uid: process.getuid() + 1 }), BridgeSecurityError);
  verifyBridgeDir(dir);
});

test("missing paths rethrow ENOENT unchanged", () => {
  const dir = bridgeDir(tmpHome());
  assert.throws(() => verifyBridgeDir(dir), (e) => e.code === "ENOENT");
  assert.throws(() => verifySocketOwner(path.join(dir, "bridge.sock")), (e) => e.code === "ENOENT");
});

test("verifySocketOwner accepts our socket and refuses anything else", async () => {
  const dir = bridgeDir(tmpHome());
  prepareBridgeDir(dir);
  const sock = path.join(dir, "bridge.sock");
  const srv = net.createServer().listen(sock);
  await new Promise((r) => srv.once("listening", r));
  verifySocketOwner(sock);
  assert.throws(() => verifySocketOwner(sock, { uid: process.getuid() + 1 }), BridgeSecurityError);
  await new Promise((r) => srv.close(r));
  const file = path.join(dir, "file");
  fs.writeFileSync(file, "x");
  assert.throws(() => verifySocketOwner(file), BridgeSecurityError);
});

test("socket path length limits (sun_path minus NUL)", () => {
  assert.doesNotThrow(() => assertSocketPathFits("/" + "a".repeat(102), "darwin"));
  assert.throws(() => assertSocketPathFits("/" + "a".repeat(103), "darwin"), BridgeSecurityError);
  assert.doesNotThrow(() => assertSocketPathFits("/" + "a".repeat(106), "linux"));
  assert.throws(() => assertSocketPathFits("/" + "a".repeat(107), "linux"), BridgeSecurityError);
});
