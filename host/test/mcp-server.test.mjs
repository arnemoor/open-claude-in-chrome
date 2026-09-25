// MCP-server-level behavior not covered elsewhere: parity.test.mjs is scoped
// to tool/schema parity and dispatch, and the lower-level bridge-hub/client
// suites never go through a real mcp-server.js child. This file covers an
// extension-side tool_error reaching the MCP caller, applySaveToDisk wired
// through callTool (standalone and inside browser_batch), the bridge's
// connect grace as observed from a real mcp-server.js process, the isError
// flag on every failure reply, and browser_batch's validation of each nested
// action against that tool's own input schema.
//
// Harness mirrors parity.test.mjs's own (isolated HOME per block, an
// in-process bridge hub standing in for the extension, a real
// `node mcp-server.js` child connected to it as a bridge client).

import { test, describe, it, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { startHub } from "./helpers.mjs";
import { LOST, TOO_LARGE } from "../bridge-client.js";

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

  it("returns the error as the MCP tool result text, flagged isError", { timeout: 10000 }, async () => {
    const result = await session.client.callTool({ name: "navigate", arguments: { url: "https://example.com", tabId: 1 } });
    assert.equal(textOf(result), "Error: boom from the extension");
    assert.equal(result.isError, true);
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
    assert.equal(result.isError, true);
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

// --- isError: every failure reply is flagged, a success reply never is --------

describe("failure replies carry isError: true, success replies never do", () => {
  let session, home, hub, ext, respond;
  const forwarded = [];
  const ok = (msg) => ext.reply(msg, { content: [{ type: "text", text: "ok" }] });
  const b64 = Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString("base64"); // stand-in jpeg bytes

  before(async () => {
    const iso = isolatedEnv();
    home = iso.home;
    ({ hub, ext } = await startHub(home));
    respond = ok;
    hub.sendToExtension = (msg) => {
      forwarded.push(msg);
      respond(msg);
    };
    session = await startSession(iso.env);
    assert.ok(await waitForRoute(session.client), "mock native host should be connected and routing tool calls");
  }, { timeout: 20000 });

  beforeEach(() => {
    forwarded.length = 0;
    respond = ok;
  });

  after(async () => {
    if (session) await session.transport.close().catch(() => {});
    if (hub) await hub.stop("test");
    try { fs.rmSync(home, { recursive: true, force: true }); } catch {}
  }, { timeout: 10000 });

  it("a successful reply has no isError", { timeout: 10000 }, async () => {
    const result = await session.client.callTool({ name: "navigate", arguments: { url: "https://example.com", tabId: 1 } });
    assert.equal(textOf(result), "ok");
    assert.equal(result.isError, undefined);
  });

  it("an extension result flagged isError reaches the caller unchanged", { timeout: 10000 }, async () => {
    const content = [{ type: "text", text: "Tab 1 is not in the MCP group." }];
    respond = (msg) => ext.reply(msg, { content, isError: true });
    const result = await session.client.callTool({ name: "get_page_text", arguments: { tabId: 1 } });
    assert.deepEqual(result.content, content);
    assert.equal(result.isError, true);
  });

  it("save_to_disk keeps an extension result's isError", { timeout: 10000 }, async () => {
    respond = (msg) => ext.reply(msg, {
      content: [
        { type: "image", data: b64, mimeType: "image/jpeg", saveToDisk: "screenshot" },
        { type: "text", text: "Action 2 (computer) failed: boom" },
      ],
      isError: true,
    });
    const result = await session.client.callTool({
      name: "browser_batch",
      arguments: {
        actions: [
          { name: "computer", input: { action: "screenshot", tabId: 1, save_to_disk: true } },
          { name: "computer", input: { action: "left_click", coordinate: [1, 2], tabId: 1 } },
        ],
      },
    });
    assert.match(textOf(result), /Saved to disk: .*screenshot_.*\.jpg/);
    assert.equal(result.isError, true);
  });

  it("the host's own upload refusal is flagged, and never reaches the browser", { timeout: 10000 }, async () => {
    const result = await session.client.callTool({ name: "file_upload", arguments: { paths: ["/etc/hosts"], ref: "ref_1", tabId: 1 } });
    assert.match(textOf(result), /^Error: Not in an allowed upload folder: \/etc\/hosts\./);
    assert.equal(result.isError, true);
    assert.equal(forwarded.length, 0);
  });

  it("a request too large for the browser channel is flagged", { timeout: 10000 }, async () => {
    const result = await session.client.callTool({ name: "navigate", arguments: { url: `https://example.com/${"a".repeat(1_000_000)}`, tabId: 1 } });
    assert.equal(textOf(result), `Error: ${TOO_LARGE}`);
    assert.equal(result.isError, true);
    assert.equal(forwarded.length, 0);
  });
});

describe("a browser connection lost mid-call", () => {
  it("replies with the LOST message, flagged isError", { timeout: 20000 }, async (t) => {
    const iso = isolatedEnv();
    const { hub, ext } = await startHub(iso.home);
    let drop = false;
    hub.sendToExtension = (msg) => {
      if (drop) hub.stop("test").catch(() => {});
      else ext.reply(msg, { content: [{ type: "text", text: "ok" }] });
    };
    const session = await startSession(iso.env);
    t.after(async () => {
      await session.transport.close().catch(() => {});
      await hub.stop("test").catch(() => {});
      try { fs.rmSync(iso.home, { recursive: true, force: true }); } catch {}
    });
    assert.ok(await waitForRoute(session.client), "mock native host should be connected and routing tool calls");

    drop = true;
    const result = await session.client.callTool({ name: "computer", arguments: { action: "wait", duration: 1, tabId: 1 } });
    assert.equal(textOf(result), `Error: ${LOST}`);
    assert.equal(result.isError, true);
  });
});

// --- browser_batch: each nested action is validated like the standalone tool ---

describe("browser_batch validates every nested action against that tool's own input schema", () => {
  let session, home, hub;
  const forwarded = [];

  before(async () => {
    const iso = isolatedEnv();
    home = iso.home;
    ({ hub } = await startHub(home));
    hub.sendToExtension = (msg) => {
      forwarded.push(msg);
      hub.handleExtensionMessage({ type: "tool_response", id: msg.id, result: { content: [{ type: "text", text: "ok" }] } });
    };
    session = await startSession(iso.env);
    assert.ok(await waitForRoute(session.client), "mock native host should be connected and routing tool calls");
  }, { timeout: 20000 });

  beforeEach(() => {
    forwarded.length = 0;
  });

  after(async () => {
    if (session) await session.transport.close().catch(() => {});
    if (hub) await hub.stop("test");
    try { fs.rmSync(home, { recursive: true, force: true }); } catch {}
  }, { timeout: 10000 });

  const batch = (actions) => session.client.callTool({ name: "browser_batch", arguments: { actions } });
  const navigateOk = { name: "navigate", input: { url: "https://example.com", tabId: 1 } };

  for (const [label, actions, expected] of [
    ["a wrong type", [navigateOk, { name: "navigate", input: { url: 42, tabId: 1 } }], /^Error: Action 2 \(navigate\): invalid input\. url: /],
    ["a value outside an enum", [{ name: "computer", input: { action: "fly", tabId: 1 } }], /^Error: Action 1 \(computer\): invalid input\. action: /],
    ["a missing required field", [navigateOk, { name: "computer", input: { action: "screenshot" } }], /^Error: Action 2 \(computer\): invalid input\. tabId: /],
    ["an unknown tool name", [navigateOk, { name: "no_such_tool", input: {} }], /^Error: Action 2 \(no_such_tool\): unknown tool\./],
    ["a nested browser_batch", [{ name: "browser_batch", input: { actions: [navigateOk] } }], /^Error: Action 1 \(browser_batch\): nested browser_batch is not allowed\./],
    ["a file_upload outside the allowed folders", [navigateOk, { name: "file_upload", input: { paths: ["/etc/hosts"], ref: "ref_1", tabId: 1 } }], /^Error: Action 2 \(file_upload\): Not in an allowed upload folder: /],
  ]) {
    it(`rejects the whole batch for ${label}, flagged isError, before anything reaches the browser`, { timeout: 10000 }, async () => {
      const result = await batch(actions);
      const text = textOf(result);
      assert.match(text, expected);
      assert.match(text, / No action in this batch was run\.$/);
      assert.equal(result.isError, true);
      assert.equal(forwarded.length, 0, "no request may reach the browser for a rejected batch");
    });
  }

  it("names every problem with an action's input", { timeout: 10000 }, async () => {
    const result = await batch([{ name: "navigate", input: { url: 42 } }]);
    assert.match(textOf(result), /^Error: Action 1 \(navigate\): invalid input\. url: .*\. tabId: .*\. No action in this batch was run\.$/);
  });

  it("forwards a valid batch with every nested input unchanged", { timeout: 10000 }, async () => {
    const actions = [
      navigateOk,
      { name: "computer", input: { action: "left_click", coordinate: [10, 20], tabId: 1 } },
      { name: "form_input", input: { ref: "ref_1", value: true, tabId: 1 } },
      { name: "find", input: { query: "search bar", tabId: 1 } },
      { name: "tabs_create_mcp", input: {} },
    ];
    const result = await batch(actions);
    assert.equal(textOf(result), "ok");
    assert.equal(result.isError, undefined);
    assert.equal(forwarded.length, 1);
    assert.equal(forwarded[0].tool, "browser_batch");
    assert.deepEqual(forwarded[0].args, { actions });
  });

  it("coerces a nested string tabId and coordinate the same way as a standalone call", { timeout: 10000 }, async () => {
    const result = await batch([{ name: "computer", input: { action: "left_click", coordinate: "[10, 20]", tabId: "7" } }]);
    assert.equal(result.isError, undefined);
    assert.deepEqual(forwarded[0].args.actions[0].input, { action: "left_click", coordinate: [10, 20], tabId: 7 });
  });
});
