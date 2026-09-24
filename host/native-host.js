#!/usr/bin/env node

// Native messaging host for Open Claude in Chrome. The browser starts it when the
// extension calls connectNative(). It owns the bridge hub: MCP servers connect to its
// Unix socket, and it relays their tool requests to the extension over native
// messaging (4-byte little-endian length + JSON on stdin/stdout). Nothing but
// native-messaging frames may ever be written to stdout.

import fs from "node:fs";
import { BridgeHub } from "./bridge-hub.js";
import { bridgePath, BridgeSecurityError } from "./bridge-endpoint.js";
import { createLogger } from "./log.js";

function readNativeMessages(buffer) {
  const messages = [];
  let offset = 0;
  while (offset + 4 <= buffer.length) {
    const len = buffer.readUInt32LE(offset);
    if (offset + 4 + len > buffer.length) break;
    try {
      messages.push(JSON.parse(buffer.subarray(offset + 4, offset + 4 + len).toString("utf-8")));
    } catch {
      // skip malformed
    }
    offset += 4 + len;
  }
  return { messages, remainder: buffer.subarray(offset) };
}

function writeNativeMessage(obj) {
  const body = Buffer.from(JSON.stringify(obj), "utf-8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  process.stdout.write(Buffer.concat([header, body]));
}

const logger = createLogger("native-host");
const log = (event, data = {}) => {
  process.stderr.write(`[native-host] ${event} ${JSON.stringify(data)}\n`);
  logger.info(event, data);
};
const hub = new BridgeHub({ sockPath: bridgePath(), sendToExtension: writeNativeMessage, log });

const { version } = JSON.parse(fs.readFileSync(new URL("./package.json", import.meta.url), "utf-8"));
log("start", { version, node: process.version });

let stdinBuffer = Buffer.alloc(0);
process.stdin.on("data", (chunk) => {
  stdinBuffer = Buffer.concat([stdinBuffer, chunk]);
  const { messages, remainder } = readNativeMessages(stdinBuffer);
  stdinBuffer = remainder;
  for (const msg of messages) hub.handleExtensionMessage(msg);
});

let exiting = false;
async function exit(code, reason) {
  if (exiting) return;
  exiting = true;
  process.stderr.write(`[native-host] exit ${JSON.stringify({ reason, code })}\n`);
  logger.error("exit", { reason, code });
  await hub.stop(reason).catch(() => {});
  process.exit(code);
}

process.stdin.on("end", () => exit(0, "stdin closed"));
process.on("SIGTERM", () => exit(0, "SIGTERM"));
process.on("SIGINT", () => exit(0, "SIGINT"));
process.on("uncaughtException", (err) => exit(1, `uncaught: ${err.stack || err.message}`));

// An unsafe bridge directory must not crash-loop us: the extension would respawn this
// process every 2 s. Stay alive and retry, so the problem shows up in the log.
async function startHub() {
  try {
    await hub.start();
  } catch (err) {
    log("start_failed", { message: err.message });
    if (err instanceof BridgeSecurityError) setTimeout(startHub, 30000);
    else exit(1, `start failed: ${err.message}`);
  }
}
startHub();
