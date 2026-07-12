// Drop-in parity conformance suite for the Open Claude in Chrome MCP server.
//
// The official Claude-in-Chrome extension exposes 22 tools. For this fork to be
// a drop-in replacement, `node mcp-server.js` must (a) load into an MCP client
// and advertise exactly those 22 tools, (b) advertise input schemas that are
// semantically equivalent to the official ones, and (c) actually dispatch each
// call to the browser (native host) with the arguments the caller passed. This
// suite proves all three, without a real browser, using a mock native host.
//
// The fixture host/test/claude-in-chrome-tools.schema.json is the SOURCE OF
// TRUTH: its 22 keys (minus the "mcp__claude-in-chrome__" prefix) are the
// official tool names, and its values are the official input schemas.
//
// It is a PARITY suite, not a characterization suite: every assertion encodes
// the drop-in target, so a red result localizes remaining parity work rather
// than a broken test. The suite currently passes: the fork registers exactly
// the 22 official tools, with semantically-equivalent schemas, and dispatches
// each call correctly. What it does NOT prove: actual in-browser behavior (the
// mock native host only records the request and replies with a canned result).
// So tools kept as honest stubs (shortcuts_list, shortcuts_execute,
// switch_browser, list_connected_browsers, select_browser, gif_creator) and
// schema-only params (computer.save_to_disk) pass dispatch but are NOT
// behaviorally equivalent to the official extension. See issue #1.
//
// Harness (isolatedEnv / mock native host / spawned server) is reused from
// multi-session.test.mjs and auth.test.mjs. Ports 18850+ keep this suite from
// clashing with those (18831/18832) and auth (18841).
//
// Run: npm test   (from host/)

import { test, describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SERVER = path.join(import.meta.dirname, "..", "mcp-server.js");
const FIXTURE = path.join(import.meta.dirname, "claude-in-chrome-tools.schema.json");
const PREFIX = "mcp__claude-in-chrome__";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- Source of truth: the official 22 tools + their input schemas ------------

const rawFixture = JSON.parse(fs.readFileSync(FIXTURE, "utf-8"));
const OFFICIAL = {}; // name (no prefix) -> official input schema
for (const [key, schema] of Object.entries(rawFixture)) {
  if (!key.startsWith(PREFIX)) continue;
  OFFICIAL[key.slice(PREFIX.length)] = schema;
}
const OFFICIAL_NAMES = Object.keys(OFFICIAL).sort();

// Per-tool exampleInput from the audit. Each is a valid call for the DISPATCH
// test: for the 17 registered official tools it passes the served Zod schema and
// reaches the mock native host; the 5 unregistered tools naturally fail to
// dispatch, which is the parity finding for them.
const EXAMPLE_INPUTS = {
  browser_batch: {
    actions: [
      { name: "navigate", input: { url: "https://example.com", tabId: 123 } },
      { name: "computer", input: { action: "screenshot", tabId: 123 } },
    ],
  },
  computer: { action: "left_click", coordinate: [100, 200], tabId: 123 },
  file_upload: { paths: ["/Users/arm/Documents/report.pdf"], ref: "ref_1", tabId: 123 },
  find: { query: "search bar", tabId: 123 },
  form_input: { ref: "ref_1", value: "hello@example.com", tabId: 123 },
  get_page_text: { tabId: 123 },
  gif_creator: { action: "start_recording", tabId: 123 },
  javascript_tool: { action: "javascript_exec", text: "document.title", tabId: 123 },
  list_connected_browsers: {},
  navigate: { url: "https://example.com", tabId: 123 },
  read_console_messages: { tabId: 123, pattern: "error|warning", onlyErrors: false, limit: 100, clear: false },
  read_network_requests: { tabId: 123, urlPattern: "/api/", limit: 100, clear: false },
  read_page: { tabId: 123, filter: "interactive" },
  resize_window: { width: 1280, height: 800, tabId: 123 },
  select_browser: { deviceId: "device-123abc" },
  shortcuts_execute: { tabId: 123, command: "summarize" },
  shortcuts_list: { tabId: 123 },
  switch_browser: {},
  tabs_close_mcp: { tabId: 123 },
  tabs_context_mcp: { createIfEmpty: true },
  tabs_create_mcp: {},
  upload_image: { imageId: "screenshot_1730000000000", ref: "ref_5", filename: "image.png", tabId: 123 },
};

// --- Test harness (adapted from multi-session.test.mjs / auth.test.mjs) -------

function isolatedEnv(port) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ocic-parity-"));
  const cfgDir = path.join(home, ".config", "open-claude-in-chrome");
  fs.mkdirSync(cfgDir, { recursive: true });
  fs.writeFileSync(path.join(cfgDir, "config.json"), JSON.stringify({ port }));
  const token = `test-token-${port}`;
  fs.writeFileSync(path.join(cfgDir, "token"), token, { mode: 0o600 });
  return { env: { ...process.env, HOME: home }, home, token };
}

// A stand-in for the browser's native host: connects, authenticates with
// native_hello, RECORDS every tool_request it receives into `recorded`, and
// answers each with MOCK_OK so the caller's callTool resolves.
function startRecordingNativeHost(port, token, recorded) {
  let sock;
  let alive = true;
  function connect() {
    sock = net.createConnection(port, "127.0.0.1", () => {
      sock.write(JSON.stringify({ type: "native_hello", token }) + "\n");
    });
    let buf = Buffer.alloc(0);
    sock.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      let i;
      while ((i = buf.indexOf(10)) !== -1) {
        const line = buf.subarray(0, i).toString("utf-8").trim();
        buf = buf.subarray(i + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.type === "tool_request") {
          recorded.push({ id: msg.id, tool: msg.tool, args: msg.args });
          sock.write(JSON.stringify({
            id: msg.id, type: "tool_response",
            result: { content: [{ type: "text", text: "MOCK_OK" }] },
          }) + "\n");
        }
      }
    });
    sock.on("error", () => {});
    sock.on("close", () => { if (alive) setTimeout(connect, 300); });
  }
  connect();
  return { stop() { alive = false; try { sock.destroy(); } catch {} } };
}

// Spawn `node mcp-server.js` and connect a real MCP SDK client over stdio.
async function startSession(env) {
  const transport = new StdioClientTransport({ command: "node", args: [SERVER], env, stderr: "ignore" });
  const client = new Client({ name: "parity-test", version: "1.0.0" }, { capabilities: {} });
  await client.connect(transport);
  return { client, transport };
}

async function listToolsMap(client) {
  const { tools } = await client.listTools();
  const map = new Map();
  for (const t of tools) map.set(t.name, t.inputSchema);
  return map;
}

// Poll a real tool call until the mock native host is attached and routing (so
// dispatch tests don't race the native host's TCP handshake).
async function waitForRoute(client, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await client.callTool({ name: "tabs_context_mcp", arguments: {} });
      if (JSON.stringify(res).includes("MOCK_OK")) return true;
    } catch { /* server up, native host not attached yet */ }
    await sleep(250);
  }
  return false;
}

// --- Semantic schema comparison ----------------------------------------------
// Compares a served input schema (produced by zod-to-json-schema) against the
// fixture on MEANING only: property-name set, required set, and per-property
// type-set + enum value-set. Tolerant of zod-to-json-schema shape quirks
// (const<->single-enum, anyOf<->type-array) and of description wording; never
// deep-equals raw JSON, and ignores numeric bounds / $schema / etc.

function jsonType(v) {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v; // "string" | "number" | "boolean" | "object"
}

// The set of JSON types a property accepts, flattening unions.
function typeSet(prop) {
  const out = new Set();
  const visit = (s) => {
    if (!s || typeof s !== "object") return;
    if (typeof s.type === "string") out.add(s.type);
    else if (Array.isArray(s.type)) s.type.forEach((t) => out.add(t));
    for (const k of ["anyOf", "oneOf", "allOf"]) {
      if (Array.isArray(s[k])) s[k].forEach(visit);
    }
  };
  visit(prop);
  if (out.size === 0) {
    // No explicit type anywhere: infer from const/enum values.
    if ("const" in prop) out.add(jsonType(prop.const));
    else if (Array.isArray(prop.enum)) prop.enum.forEach((v) => out.add(jsonType(v)));
  }
  return [...out].sort();
}

// The set of literal values a property is constrained to (enum or const),
// or null when it imposes no value-set constraint. const is normalized to a
// single-value enum (a pure zod-to-json-schema shape quirk).
function enumSet(prop) {
  const vals = new Set();
  let constrained = false;
  const visit = (s) => {
    if (!s || typeof s !== "object") return;
    if (Array.isArray(s.enum)) { constrained = true; s.enum.forEach((v) => vals.add(v)); }
    if ("const" in s) { constrained = true; vals.add(s.const); }
    for (const k of ["anyOf", "oneOf", "allOf"]) {
      if (Array.isArray(s[k])) s[k].forEach(visit);
    }
  };
  visit(prop);
  return constrained ? vals : null;
}

function sameEnum(a, b) {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

// Returns a list of human-readable divergences; empty means the schemas are
// semantically equivalent.
function schemaProblems(served, fixture) {
  if (!served) return ["not served by the mcp-server (tool is not registered)"];
  const problems = [];

  const sProps = served.properties || {};
  const fProps = fixture.properties || {};
  const sNames = new Set(Object.keys(sProps));
  const fNames = new Set(Object.keys(fProps));

  const missing = [...fNames].filter((n) => !sNames.has(n));
  const extra = [...sNames].filter((n) => !fNames.has(n));
  if (missing.length) problems.push(`missing propert${missing.length > 1 ? "ies" : "y"}: ${missing.join(", ")}`);
  if (extra.length) problems.push(`unexpected propert${extra.length > 1 ? "ies" : "y"}: ${extra.join(", ")}`);

  const sReq = [...new Set(served.required || [])].sort();
  const fReq = [...new Set(fixture.required || [])].sort();
  if (sReq.join("|") !== fReq.join("|")) {
    problems.push(`required set mismatch: served [${sReq.join(", ")}] vs fixture [${fReq.join(", ")}]`);
  }

  for (const name of [...fNames].filter((n) => sNames.has(n)).sort()) {
    const st = typeSet(sProps[name]);
    const ft = typeSet(fProps[name]);
    if (st.join("|") !== ft.join("|")) {
      problems.push(`property "${name}" type-set mismatch: served {${st.join(",")}} vs fixture {${ft.join(",")}}`);
    }
    const se = enumSet(sProps[name]);
    const fe = enumSet(fProps[name]);
    if (!sameEnum(se, fe)) {
      const fmt = (e) => (e === null ? "(no enum)" : `{${[...e].join(",")}}`);
      problems.push(`property "${name}" enum value-set mismatch: served ${fmt(se)} vs fixture ${fmt(fe)}`);
    }
  }
  return problems;
}

// Mirror mcp-server.js pre-validation coercion (mcp-server.js:445-466) so the
// dispatch expectation matches what the server actually forwards to the native
// host (e.g. a string tabId is coerced to a number before validation).
function expectedArgs(input) {
  const args = structuredClone(input);
  if (args && typeof args === "object" && !Array.isArray(args)) {
    if (typeof args.tabId === "string") args.tabId = Number(args.tabId);
    for (const k of ["coordinate", "start_coordinate", "region"]) {
      if (typeof args[k] === "string") {
        try { args[k] = JSON.parse(args[k]); } catch { /* leave as-is */ }
      }
    }
  }
  return args;
}

// --- Self-check: the suite's own fixtures must be internally consistent -------

test("harness self-check: fixture defines 22 prefixed tools with matching example inputs", () => {
  assert.equal(OFFICIAL_NAMES.length, 22, "fixture must define exactly 22 official tools");
  for (const key of Object.keys(rawFixture)) {
    assert.ok(key.startsWith(PREFIX), `fixture key "${key}" must carry the ${PREFIX} prefix`);
  }
  assert.deepEqual(
    Object.keys(EXAMPLE_INPUTS).sort(),
    OFFICIAL_NAMES,
    "every official tool needs exactly one exampleInput (and no extras)"
  );
});

// --- TEST 1 + TEST 2: loadability, presence, and per-tool schema parity ------
// One spawned server; listTools() needs no native host.

describe("tool surface parity (loadability + schema compliance)", () => {
  const PORT = 18850;
  let session;
  let home;
  let served; // Map<name, inputSchema>

  before(async () => {
    const iso = isolatedEnv(PORT);
    home = iso.home;
    session = await startSession(iso.env);
    served = await listToolsMap(session.client);
  });

  after(async () => {
    if (session) await session.transport.close().catch(() => {});
    try { fs.rmSync(home, { recursive: true, force: true }); } catch {}
  });

  // TEST 1: LOADABILITY + PRESENCE
  it("loads into an MCP client and serves EXACTLY the 22 official tools", () => {
    const servedNames = [...served.keys()].sort();
    const missing = OFFICIAL_NAMES.filter((n) => !served.has(n));
    const extra = servedNames.filter((n) => !OFFICIAL_NAMES.includes(n));
    assert.deepEqual(
      servedNames,
      OFFICIAL_NAMES,
      `served tool set must equal the 22 official tools (drop-in surface).\n` +
        `  missing (official, not served): [${missing.join(", ")}]\n` +
        `  unexpected (served, not official): [${extra.join(", ")}]`
    );
  });

  // TEST 2: SCHEMA COMPLIANCE, per tool so a failure names the tool.
  describe("input schema is semantically equivalent to the fixture", () => {
    for (const name of OFFICIAL_NAMES) {
      it(name, () => {
        const problems = schemaProblems(served.get(name), OFFICIAL[name]);
        assert.equal(
          problems.length,
          0,
          `${name} input schema diverges from the fixture:\n  - ${problems.join("\n  - ")}`
        );
      });
    }
  });
});

// --- TEST 3: DISPATCH, per tool ----------------------------------------------
// One spawned server + a recording mock native host. Each tool is called with
// its exampleInput; the native host must receive a matching tool_request.

describe("dispatch parity (each tool reaches the browser with matching args)", () => {
  const PORT = 18851;
  let session;
  let home;
  let nativeHost;
  const recorded = [];

  before(async () => {
    const iso = isolatedEnv(PORT);
    home = iso.home;
    nativeHost = startRecordingNativeHost(PORT, iso.token, recorded);
    session = await startSession(iso.env);
    const routed = await waitForRoute(session.client);
    assert.ok(routed, "mock native host should attach to the primary and route tool calls");
    recorded.length = 0; // discard the readiness-probe request(s)
  });

  after(async () => {
    if (session) await session.transport.close().catch(() => {});
    if (nativeHost) nativeHost.stop();
    try { fs.rmSync(home, { recursive: true, force: true }); } catch {}
  });

  for (const name of OFFICIAL_NAMES) {
    it(name, async () => {
      const input = EXAMPLE_INPUTS[name];
      let callError = null;
      try {
        await session.client.callTool({ name, arguments: structuredClone(input) });
      } catch (err) {
        callError = err; // unregistered tools reject here; assertion below reports it
      }

      // Match by unique tool name (each official tool is dispatched exactly once).
      const req = recorded.find((r) => r.tool === name);
      assert.ok(
        req,
        `native host should have received a '${name}' tool_request` +
          (callError
            ? ` — callTool errored: ${callError.message}`
            : recorded.length
              ? ` (dispatched instead: ${recorded.map((r) => r.tool).join(", ")})`
              : " (nothing was dispatched)")
      );

      assert.deepEqual(
        req.args,
        expectedArgs(input),
        `'${name}' must dispatch the caller's arguments (after mcp-server coercion) unchanged`
      );
    });
  }
});
