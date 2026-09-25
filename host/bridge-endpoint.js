// Where the native host (hub) and the MCP servers (clients) meet: a Unix socket in a
// directory only the current user can enter. The directory check replaces the old
// shared token and protects both directions: other users cannot reach the hub, and a
// client knows the socket was created by its own user. This rests on HOME and its
// parent folders not being writable by other users; the bridge's security holds only
// as long as that's true.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const PROTOCOL_VERSION = 2;

export class BridgeSecurityError extends Error {
  constructor(message) {
    super(message);
    this.name = "BridgeSecurityError";
  }
}

export function bridgeDir(home = os.homedir()) {
  return path.join(home, ".config", "open-claude-in-chrome", "run");
}

export function bridgePath(home = os.homedir()) {
  return path.join(bridgeDir(home), "bridge.sock");
}

function lstatOrThrow(p, what) {
  try {
    return fs.lstatSync(p);
  } catch (e) {
    if (e.code === "ENOENT") throw e;
    throw new BridgeSecurityError(`${what} ${p} is not accessible: ${e.message}`);
  }
}

export function verifyBridgeDir(dir, { uid = process.getuid() } = {}) {
  const st = lstatOrThrow(dir, "Bridge directory");
  if (st.isSymbolicLink()) throw new BridgeSecurityError(`Bridge directory ${dir} is a symlink.`);
  if (!st.isDirectory()) throw new BridgeSecurityError(`Bridge directory ${dir} is not a directory.`);
  if (st.uid !== uid) throw new BridgeSecurityError(`Bridge directory ${dir} is owned by uid ${st.uid}, not ${uid}.`);
  if ((st.mode & 0o077) !== 0) {
    throw new BridgeSecurityError(`Bridge directory ${dir} is open to other users (mode ${(st.mode & 0o777).toString(8)}).`);
  }
}

export function prepareBridgeDir(dir, { uid = process.getuid() } = {}) {
  let mkdirErr;
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch (e) {
    mkdirErr = e;
    // A file or symlink in the way is judged by the checks below; if nothing
    // is there afterward, this was a real failure (EACCES, ENOSPC, ...).
  }
  let st;
  try {
    st = lstatOrThrow(dir, "Bridge directory");
  } catch (e) {
    if (e.code === "ENOENT" && mkdirErr) {
      throw new BridgeSecurityError(`Bridge directory ${dir} cannot be created: ${mkdirErr.code || mkdirErr.message}`);
    }
    throw e;
  }
  if (st.isDirectory() && !st.isSymbolicLink() && st.uid === uid && (st.mode & 0o777) !== 0o700) {
    fs.chmodSync(dir, 0o700);
  }
  verifyBridgeDir(dir, { uid });
}

export function verifySocketOwner(sockPath, { uid = process.getuid() } = {}) {
  const st = lstatOrThrow(sockPath, "Bridge socket");
  if (!st.isSocket()) throw new BridgeSecurityError(`${sockPath} is not a socket.`);
  if (st.uid !== uid) throw new BridgeSecurityError(`Bridge socket ${sockPath} is owned by uid ${st.uid}, not ${uid}.`);
}

export function assertSocketPathFits(sockPath, platform = process.platform) {
  const max = platform === "linux" ? 107 : 103;
  const len = Buffer.byteLength(sockPath);
  if (len > max) {
    throw new BridgeSecurityError(`Bridge socket path is ${len} bytes, over the ${max}-byte limit: ${sockPath}. Use a shorter home directory path.`);
  }
}
