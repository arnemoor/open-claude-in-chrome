// MCP-server-level behavior not covered elsewhere: parity.test.mjs is scoped
// to tool/schema parity and dispatch, and the lower-level bridge-hub/client
// suites never go through a real mcp-server.js child. This file covers three
// gaps (M7): an extension-side tool_error reaching the MCP caller, applySaveToDisk
// wired through callTool (standalone and inside browser_batch), and the
// bridge's connect grace as observed from a real mcp-server.js process.
//
// Harness mirrors parity.test.mjs's own (isolated HOME per block, an
// in-process bridge hub standing in for the extension, a real
// `node mcp-server.js` child connected to it as a bridge client).

import { test, describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { startHub } from "./helpers.mjs";

const SERVER = path.join(import.meta.dirname, "..", "mcp-server.js");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isolatedEnv(extra = {}) {
  const home = fs.mkdtempSync("/tmp/ocic-");
  return { env: { ...process.env, HOME: home, OCIC_CONNECT_GRACE_MS: "2000", ...extra }, home };
}

async function startSession(env) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [SERVER], env, stderr: "ignore" });
  const client = new Client({ name: "mcp-server-test", version: "1.0.0" }, { capabilities: {} });
  await client.connect(transport);
  return { client, transport };
}

// Poll a real tool call until the fake hub is attached and routing (mirrors
// parity.test.mjs's own waitForRoute, so dispatch tests don't race the
// bridge client's connect handshake).
async function waitForRoute(client, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await client.callTool({ name: "tabs_context_mcp", arguments: {} });
      if (res?.content?.[0]?.type === "text" && res.content[0].text === "ok") return true;
    } catch { /* server up, hub not attached yet */ }
    await sleep(250);
  }
  return false;
}

function textOf(result) {
  return result.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
}

// --- M7: an extension tool_error reaches the MCP caller ----------------------

describe("an extension tool_error is routed through the hub and client to the MCP reply", () => {
  let session, home, hub, ext, ready;

  before(async () => {
    const iso = isolatedEnv();
    home = iso.home;
    ({ hub, ext } = await startHub(home));
    ready = false;
    // startHub() wires sendToExtension to ext.send at construction time, so
    // overriding the hub's own property (not ext.send) is what the hub
    // actually re-reads on every call.
    hub.sendToExtension = (msg) => {
      if (ready) ext.fail(msg, "boom from the extension");
      else ext.reply(msg, { content: [{ type: "text", text: "ok" }] });
    };
    session = await startSession(iso.env);
    assert.ok(await waitForRoute(session.client), "mock native host should be connected and routing tool calls");
    ready = true;
  }, { timeout: 20000 });

  after(async () => {
    if (session) await session.transport.close().catch(() => {});
    if (hub) await hub.stop("test");
    try { fs.rmSync(home, { recursive: true, force: true }); } catch {}
  }, { timeout: 10000 });

  it("returns the error as the MCP tool result text", { timeout: 10000 }, async () => {
    const result = await session.client.callTool({ name: "navigate", arguments: { url: "https://example.com", tabId: 1 } });
    assert.equal(textOf(result), "Error: boom from the extension");
  });
});

// --- M7: applySaveToDisk wired through callTool -------------------------------

describe("applySaveToDisk is wired through callTool", () => {
  let session, home, hub, ready;
  const b64 = Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString("base64"); // stand-in jpeg bytes

  before(async () => {
    const iso = isolatedEnv();
    home = iso.home;
    ({ hub } = await startHub(home));
    ready = false;
    hub.sendToExtension = (msg) => hub.handleExtensionMessage({
      type: "tool_response",
      id: msg.id,
      result: ready
        ? { content: [{ type: "image", data: b64, mimeType: "image/jpeg", saveToDisk: "screenshot" }] }
        : { content: [{ type: "text", text: "ok" }] },
    });
    session = await startSession(iso.env);
    assert.ok(await waitForRoute(session.client), "mock native host should be connected and routing tool calls");
    ready = true;
  }, { timeout: 20000 });

  after(async () => {
    if (session) await session.transport.close().catch(() => {});
    if (hub) await hub.stop("test");
    try { fs.rmSync(home, { recursive: true, force: true }); } catch {}
  }, { timeout: 10000 });

  it("writes the file and reports the path for a standalone call", { timeout: 10000 }, async () => {
    const result = await session.client.callTool({ name: "computer", arguments: { action: "screenshot", tabId: 1, save_to_disk: true } });
    const text = textOf(result);
    assert.match(text, /Saved to disk: .*screenshot_.*\.jpg/);
    const saved = text.match(/Saved to disk: (.*\.jpg)/)[1];
    assert.ok(fs.existsSync(saved));
    assert.ok(saved.startsWith(path.join(home, "Downloads", "open-claude-in-chrome")));
  });

  it("also applies inside browser_batch", { timeout: 10000 }, async () => {
    const result = await session.client.callTool({
      name: "browser_batch",
      arguments: { actions: [{ name: "computer", input: { action: "screenshot", tabId: 1, save_to_disk: true } }] },
    });
    assert.match(textOf(result), /Saved to disk: .*screenshot_.*\.jpg/);
  });
});

// --- M7: the bridge's connect grace, from a real mcp-server.js ---------------

describe("the bridge's connect grace, observed through a real mcp-server.js", () => {
  it("a tool call fails after the grace period with an actionable message, well under the 60s request timeout", { timeout: 15000 }, async (t) => {
    const iso = isolatedEnv({ OCIC_CONNECT_GRACE_MS: "500" });
    const session = await startSession(iso.env); // no hub is ever started
    t.after(async () => {
      await session.transport.close().catch(() => {});
      try { fs.rmSync(iso.home, { recursive: true, force: true }); } catch {}
    });

    const t0 = Date.now();
    const result = await session.client.callTool({ name: "tabs_context_mcp", arguments: {} });
    const elapsed = Date.now() - t0;
    assert.match(textOf(result), /^Error: Browser extension is not connected/);
    assert.ok(elapsed < 5000, `should fail within the grace period, not the 60s request timeout (took ${elapsed}ms)`);
  });

  it("a hub that appears within the grace period still serves the waiting call", { timeout: 15000 }, async (t) => {
    const iso = isolatedEnv({ OCIC_CONNECT_GRACE_MS: "3000" });
    const session = await startSession(iso.env);
    t.after(async () => {
      await session.transport.close().catch(() => {});
      try { fs.rmSync(iso.home, { recursive: true, force: true }); } catch {}
    });

    const callPromise = session.client.callTool({ name: "tabs_context_mcp", arguments: {} });
    await sleep(500);
    const { hub, ext } = await startHub(iso.home);
    t.after(() => hub.stop("test").catch(() => {}));
    hub.sendToExtension = (msg) => ext.reply(msg, { content: [{ type: "text", text: "ok" }] });

    const result = await callPromise;
    assert.match(textOf(result), /ok/);
  });
});
