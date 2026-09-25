// Opt-in end-to-end check: loads the REAL extension into an isolated headless
// Chrome via CDP (Extensions.loadUnpacked), registers the REAL native host
// under that isolated Chrome profile, and drives the whole stack — extension
// <-> native host <-> bridge hub <-> mcp-server.js — through a real MCP SDK
// client. Everything (Chrome profile, HOME, sockets, logs) lives under fresh
// fs.mkdtempSync() dirs and is torn down at the end. Never touches the real
// HOME, the real Chrome profile/install, or the real bridge socket.
//
// Skipped unless OCIC_E2E=1, and skipped (not failed) when Google Chrome.app
// is missing, so `node --test test/` stays fast and never launches a browser.
// With OCIC_E2E=1 and Chrome present, every other setup failure (the extension
// does not load, the native host never starts) fails the run.
//
// Run: OCIC_E2E=1 node --test test/e2e/e2e.mjs

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, execSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
// test/e2e/ has no node_modules of its own (only host/ vendors the MCP SDK),
// so the client SDK is imported by relative path into host/node_modules
// rather than as a bare specifier.
import { Client } from "../../host/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js";
import { StdioClientTransport } from "../../host/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js";
import { LOST } from "../../host/bridge-client.js";

const RUN = process.env.OCIC_E2E === "1";
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const chromeAvailable = fs.existsSync(CHROME);

const WORKTREE = path.resolve(import.meta.dirname, "..", "..");
const EXTENSION_DIR = path.join(WORKTREE, "extension");
const NATIVE_HOST_JS = path.join(WORKTREE, "host", "native-host.js");
const MCP_SERVER_JS = path.join(WORKTREE, "host", "mcp-server.js");
const HOST_NAME = "com.anthropic.open_claude_in_chrome";

const skipReason = !RUN
  ? "set OCIC_E2E=1 to run"
  : !chromeAvailable
    ? "Google Chrome.app not found"
    : false;

describe("end-to-end: real extension in an isolated headless Chrome", { skip: skipReason }, () => {
  // --- small generic helpers ---------------------------------------------

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  async function waitFor(fn, { timeoutMs = 20000, intervalMs = 300 } = {}) {
    const start = Date.now();
    for (;;) {
      const value = await fn();
      if (value) return value;
      if (Date.now() - start > timeoutMs) throw new Error("waitFor: timed out");
      await sleep(intervalMs);
    }
  }

  function reEscape(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  // ps-based process helpers. Every kill below is gated on the target's own
  // command line containing our unique, randomly-generated tempHome/profile
  // path — never a bare process name — so it can never match a live,
  // non-isolated native-host.js or mcp-server.js.
  function cmdlineOf(pid) {
    try {
      return execSync(`ps -ww -p ${pid} -o command=`, { encoding: "utf8" }).trim();
    } catch {
      return null;
    }
  }

  function pidsWithCmdlineContaining(substring) {
    let snapshot;
    try {
      snapshot = execSync("ps -A -ww -o pid=,command=", { encoding: "utf8" });
    } catch {
      return [];
    }
    const pids = [];
    for (const line of snapshot.split("\n")) {
      const m = line.match(/^\s*(\d+)\s+(.*)$/);
      if (m && m[2].includes(substring)) pids.push(Number(m[1]));
    }
    return pids;
  }

  // The last {event, pid} logged under this name, or null.
  function lastLogEvent(logPath, event) {
    let lines;
    try {
      lines = fs.readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean);
    } catch {
      return null;
    }
    for (let i = lines.length - 1; i >= 0; i--) {
      const rec = JSON.parse(lines[i]);
      if (rec.event === event) return rec;
    }
    return null;
  }

  function makePipeTransport(pipeWrite, pipeRead) {
    let buf = "";
    let seq = 0;
    const pending = new Map();
    // A Chrome that dies at startup closes the pipe without ever answering in-flight sends.
    // Reject them (and any later send) instead of hanging before() forever.
    let closedErr = null;
    const onClosed = (err) => {
      if (closedErr) return;
      closedErr = err || new Error("Chrome CDP pipe closed");
      for (const { reject } of pending.values()) reject(closedErr);
      pending.clear();
    };
    pipeRead.on("close", () => onClosed());
    pipeRead.on("error", onClosed);
    pipeWrite.on("error", onClosed);
    pipeRead.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      let idx;
      while ((idx = buf.indexOf("\0")) !== -1) {
        const raw = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (!raw) continue;
        let msg;
        try {
          msg = JSON.parse(raw);
        } catch {
          continue;
        }
        if (msg.id && pending.has(msg.id)) {
          const { resolve, reject } = pending.get(msg.id);
          pending.delete(msg.id);
          msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
        }
      }
    });
    // sessionId is only needed for a flattened Target.attachToTarget session
    // (step 10's options-page target); every other caller omits it.
    const send = (method, params = {}, sessionId) => {
      if (closedErr) return Promise.reject(closedErr);
      return new Promise((resolve, reject) => {
        const id = ++seq;
        pending.set(id, { resolve, reject });
        pipeWrite.write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + "\0");
      });
    };
    return { send };
  }

  // Runs `expression` in a specific CDP-attached page (step 10's options-page
  // target), via the browser-level pipe `send` and that page's flattened
  // sessionId. Throws the page's own exception message instead of swallowing it.
  async function evalInPage(cdpSend, sessionId, expression, { awaitPromise = false } = {}) {
    const r = await cdpSend("Runtime.evaluate", { expression, returnByValue: true, awaitPromise }, sessionId);
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text || JSON.stringify(r.exceptionDetails));
    }
    return r.result.value;
  }

  // --- local HTTP test pages ----------------------------------------------

  const HOME_HTML = `<!doctype html><html><head><title>OCIC E2E Home</title></head><body>
<h1>OCIC E2E Home</h1>
<div style="height:2200px">spacer</div>
<button id="offscreen-btn" aria-label="offscreen action button"
  onclick="this.setAttribute('aria-label','offscreen button clicked'); this.textContent='Offscreen Button Clicked'; this.setAttribute('data-clicked','1')">Offscreen Button</button>
</body></html>`;

  const FORM_HTML = `<!doctype html><html><head><title>OCIC E2E Form</title></head><body>
<h1>Greeting form</h1>
<form action="/submitted" method="GET"><input type="text" name="q" id="greet-input" autofocus></form>
</body></html>`;

  const UPLOAD_HTML = `<!doctype html><html><head><title>OCIC E2E Upload</title></head><body>
<h1>Upload</h1>
<input type="file" id="file-input" aria-label="upload file input">
<span id="upload-result"></span>
<script>
document.getElementById('file-input').addEventListener('change', function (e) {
  document.getElementById('upload-result').textContent = e.target.files[0] ? e.target.files[0].name : '';
});
</script>
</body></html>`;

  // Step 10 (audit mode): the query carries a token that must never reach
  // stored audit data, and the input is where the typed secret lands.
  const AUDIT_HTML = `<!doctype html><html><head><title>OCIC E2E Audit</title></head><body>
<h1>Audit</h1>
<input type="text" id="secret-input" autofocus>
</body></html>`;

  function startTestServer() {
    return new Promise((resolve) => {
      const server = http.createServer((req, res) => {
        const u = new URL(req.url, "http://127.0.0.1");
        if (u.pathname === "/redirect") {
          res.writeHead(302, { Location: "/redirect-target" });
          res.end();
        } else if (u.pathname === "/redirect-target") {
          reply(res, `<!doctype html><title>OCIC E2E Redirected</title><body>ok</body>`);
        } else if (u.pathname === "/submitted") {
          const q = u.searchParams.get("q") || "";
          reply(res, `<!doctype html><title>submitted:${escapeHtml(q)}</title><body><p>${escapeHtml(q)}</p></body>`);
        } else if (u.pathname === "/form") {
          reply(res, FORM_HTML);
        } else if (u.pathname === "/upload") {
          reply(res, UPLOAD_HTML);
        } else if (u.pathname === "/audit") {
          reply(res, AUDIT_HTML);
        } else {
          reply(res, HOME_HTML);
        }
      });
      server.listen(0, "127.0.0.1", () => resolve(server));
    });
  }

  function reply(res, body) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(body);
  }

  // --- shared state, built up in before() ----------------------------------

  let tempHome, profile, testServer, base, chromeProc, mcpClient, mcpTransport;
  let extensionId, nativeHostPid, tabId, cdpSend; // cdpSend: step 10 reuses the browser-level CDP pipe

  before(async () => {
    tempHome = fs.mkdtempSync("/tmp/ocic-");
    profile = fs.mkdtempSync("/tmp/ocic-chrome-");

    testServer = await startTestServer();
    base = `http://127.0.0.1:${testServer.address().port}`;

    chromeProc = spawn(
      CHROME,
      [
        "--headless=new",
        "--remote-debugging-pipe",
        "--enable-unsafe-extension-debugging",
        `--user-data-dir=${profile}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-background-networking",
        "--disable-sync",
        "--window-size=1280,900",
        "about:blank",
      ],
      { stdio: ["ignore", "pipe", "pipe", "pipe", "pipe"] },
    );
    let chromeStderr = "";
    chromeProc.stdio[2].on("data", (c) => {
      chromeStderr += c.toString("utf8");
    });
    cdpSend = makePipeTransport(chromeProc.stdio[3], chromeProc.stdio[4]).send;

    await sleep(500); // let the CDP pipe come up before the first command
    await cdpSend("Browser.getVersion");

    try {
      const result = await cdpSend("Extensions.loadUnpacked", { path: EXTENSION_DIR });
      extensionId = result.id;
    } catch (err) {
      throw new Error(
        `Extensions.loadUnpacked failed: ${err.message}\n` +
        `Chrome stderr tail:\n${chromeStderr.slice(-2000)}`,
      );
    }

    // Register the native host manifest + wrapper under the ISOLATED
    // profile only (never the real ~/Library/Application Support/Google/Chrome).
    const nmDir = path.join(profile, "NativeMessagingHosts");
    fs.mkdirSync(nmDir, { recursive: true });
    const wrapperPath = path.join(profile, "native-host-wrapper.sh");
    fs.writeFileSync(
      wrapperPath,
      `#!/bin/sh\nexport HOME="${tempHome}"\nexec "${process.execPath}" "${NATIVE_HOST_JS}"\n`,
      { mode: 0o755 },
    );
    fs.chmodSync(wrapperPath, 0o755);
    fs.writeFileSync(
      path.join(nmDir, `${HOST_NAME}.json`),
      JSON.stringify(
        {
          name: HOST_NAME,
          description: "Open Claude in Chrome Native Messaging Host (isolated e2e)",
          path: wrapperPath,
          type: "stdio",
          allowed_origins: [`chrome-extension://${extensionId}/`],
        },
        null,
        2,
      ),
    );

    const sockPath = path.join(tempHome, ".config", "open-claude-in-chrome", "run", "bridge.sock");
    const logPath = path.join(tempHome, ".config", "open-claude-in-chrome", "logs", "native-host.log");
    try {
      await waitFor(() => fs.existsSync(sockPath) && fs.existsSync(logPath), { timeoutMs: 20000, intervalMs: 400 });
    } catch {
      throw new Error(
        `The isolated native host never came up within 20s (socket or log missing under ${tempHome}).\n` +
        `Chrome stderr tail:\n${chromeStderr.slice(-2000)}`,
      );
    }

    // --- SAFETY CHECK: this must be OUR host, in OUR worktree, before any
    // tool call is made. Abort loudly (not skip) if it looks like anything
    // else, per the task's safety instructions.
    const startEvent = lastLogEvent(logPath, "start");
    assert.ok(startEvent && Number.isInteger(startEvent.pid), "native-host.log has no parseable start event");
    nativeHostPid = startEvent.pid;
    const cmd = cmdlineOf(nativeHostPid);
    assert.ok(sockPath.startsWith(tempHome), "sanity: socket path must be under our isolated tempHome");
    assert.ok(
      cmd && cmd.includes("native-host.js") && cmd.includes(WORKTREE),
      `Refusing to proceed: pid ${nativeHostPid} does not look like our isolated native host ` +
        `(expected a command line containing "native-host.js" and "${WORKTREE}", got: ${cmd})`,
    );

    mcpTransport = new StdioClientTransport({
      command: process.execPath,
      args: [MCP_SERVER_JS],
      env: { ...process.env, HOME: tempHome },
    });
    mcpClient = new Client({ name: "ocic-e2e", version: "1.0.0" }, { capabilities: {} });
    await mcpClient.connect(mcpTransport);
  }, { timeout: 60000 });

  after(async () => {
    try {
      if (mcpClient) await mcpClient.close().catch(() => {});
    } catch { /* best effort */ }
    try {
      if (chromeProc && chromeProc.exitCode === null && chromeProc.signalCode === null) {
        chromeProc.kill("SIGKILL");
        await Promise.race([
          new Promise((resolve) => chromeProc.once("exit", resolve)),
          sleep(5000),
        ]);
      }
    } catch { /* best effort */ }

    // Defense in depth: sweep for anything still referencing our isolated
    // dirs by command line (never by bare process name) and kill it.
    if (tempHome || profile) {
      const stragglers = new Set([
        ...(tempHome ? pidsWithCmdlineContaining(tempHome) : []),
        ...(profile ? pidsWithCmdlineContaining(profile) : []),
      ]);
      for (const pid of stragglers) {
        try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
      }
      if (stragglers.size > 0) {
        await sleep(300);
        const stillAlive = [...stragglers].filter((pid) => cmdlineOf(pid));
        if (stillAlive.length > 0) {
          console.error(`e2e cleanup: pids still alive after SIGKILL sweep: ${stillAlive.join(", ")}`);
        }
      }
    }

    try {
      if (testServer) await new Promise((resolve) => testServer.close(resolve));
    } catch { /* best effort */ }
    try {
      if (profile) fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch { /* best effort */ }
    try {
      if (tempHome) fs.rmSync(tempHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch { /* best effort */ }
  });

  // --- steps ----------------------------------------------------------------

  it("1. tabs_context_mcp with createIfEmpty", { timeout: 15000 }, async () => {
    const res = await mcpClient.callTool({ name: "tabs_context_mcp", arguments: { createIfEmpty: true } });
    const text = res.content[0].text;
    const parsed = JSON.parse(text.split("\n\n")[0]);
    assert.ok(parsed.tabGroupId !== null, `expected a tab group to exist, got: ${text}`);
    assert.ok(Array.isArray(parsed.availableTabs) && parsed.availableTabs.length >= 1, "expected at least one tab");
    tabId = parsed.availableTabs[0].tabId;
    assert.ok(Number.isInteger(tabId), `expected a numeric tabId, got: ${JSON.stringify(parsed)}`);
  });

  it("2. navigate to a local http test page", { timeout: 15000 }, async () => {
    const res = await mcpClient.callTool({ name: "navigate", arguments: { url: `${base}/`, tabId } });
    const text = res.content[0].text;
    assert.match(text, new RegExp(`Navigated to ${reEscape(base)}/`), `unexpected navigate reply: ${text}`);
  });

  it("3. find an off-screen button, then left_click by ref: it is scrolled and hit", { timeout: 15000 }, async () => {
    const found = await mcpClient.callTool({ name: "find", arguments: { query: "offscreen action button", tabId } });
    const foundText = found.content[0].text;
    assert.match(foundText, /\[off-screen, click by ref to scroll it into view\]/, `expected the button to be reported off-screen: ${foundText}`);
    const refMatch = foundText.match(/\[(ref_\d+)\]/);
    assert.ok(refMatch, `find returned no ref: ${foundText}`);
    const ref = refMatch[1];

    const clicked = await mcpClient.callTool({ name: "computer", arguments: { action: "left_click", ref, tabId } });
    const clickText = clicked.content[0].text;
    assert.match(clickText, /after scrolling it into view/, `expected the click to report a scroll: ${clickText}`);
    assert.match(clickText, /\bbutton\b/i, `expected the click to report hitting the button: ${clickText}`);

    // Bonus, independent confirmation the click actually landed (not just that
    // CDP dispatched a mouse event near the right pixel): the button's own
    // onclick handler rewrites its aria-label, findable again afterward (its
    // accessible name — the button also HAS an aria-label, which always wins
    // over rendered text in getAccessibleName, so only a changed aria-label,
    // not just changed textContent, is guaranteed to show up in find's output).
    const after = await mcpClient.callTool({ name: "find", arguments: { query: "offscreen button clicked", tabId } });
    assert.match(after.content[0].text, /offscreen button clicked/, `expected the click handler to have run: ${after.content[0].text}`);
  });

  it('4. type "Grüße", then key "Enter": the form submits', { timeout: 15000 }, async () => {
    await mcpClient.callTool({ name: "navigate", arguments: { url: `${base}/form`, tabId } });

    const typed = await mcpClient.callTool({ name: "computer", arguments: { action: "type", text: "Grüße", tabId } });
    assert.match(typed.content[0].text, /^Typed "Grüße"/, `unexpected type reply: ${typed.content[0].text}`);

    await mcpClient.callTool({ name: "computer", arguments: { action: "key", text: "Enter", tabId } });

    const tab = await waitFor(
      async () => {
        const ctx = await mcpClient.callTool({ name: "tabs_context_mcp", arguments: {} });
        const parsed = JSON.parse(ctx.content[0].text.split("\n\n")[0]);
        const found = parsed.availableTabs.find((x) => x.tabId === tabId);
        return found && found.url.includes("/submitted") ? found : null;
      },
      { timeoutMs: 8000, intervalMs: 300 },
    );
    assert.ok(tab.url.includes("q=Gr%C3%BC%C3%9Fe"), `expected the GET form to encode "Grüße" in the URL, got: ${tab.url}`);
    assert.equal(tab.title, "submitted:Grüße", `expected the server-reflected title to round-trip exactly, got: ${tab.title}`);
  });

  it("5. computer screenshot with save_to_disk: the file exists, mode 0600", { timeout: 15000 }, async () => {
    const res = await mcpClient.callTool({ name: "computer", arguments: { action: "screenshot", save_to_disk: true, tabId } });
    const savedBlock = res.content.find((b) => b.type === "text" && b.text.startsWith("Saved to disk:"));
    assert.ok(savedBlock, `expected a "Saved to disk:" block, got: ${JSON.stringify(res.content.map((b) => b.type))}`);
    const savedPath = savedBlock.text.slice("Saved to disk: ".length).trim();
    assert.ok(savedPath.startsWith(tempHome), `expected the screenshot under our isolated HOME, got: ${savedPath}`);
    const stat = fs.statSync(savedPath);
    assert.ok(stat.isFile() && stat.size > 0, `expected a non-empty file at ${savedPath}`);
    assert.equal(stat.mode & 0o777, 0o600, `expected mode 0600, got ${(stat.mode & 0o777).toString(8)}`);
  });

  it("6. file_upload from Downloads succeeds, from secret.txt is refused", { timeout: 15000 }, async () => {
    fs.mkdirSync(path.join(tempHome, "Downloads"), { recursive: true });
    const allowedFile = path.join(tempHome, "Downloads", "e2e-upload.txt");
    fs.writeFileSync(allowedFile, "hello e2e");
    const secretFile = path.join(tempHome, "secret.txt");
    fs.writeFileSync(secretFile, "top secret");

    await mcpClient.callTool({ name: "navigate", arguments: { url: `${base}/upload`, tabId } });
    const found = await mcpClient.callTool({ name: "find", arguments: { query: "upload file input", tabId } });
    const refMatch = found.content[0].text.match(/\[(ref_\d+)\]/);
    assert.ok(refMatch, `find returned no ref for the file input: ${found.content[0].text}`);
    const ref = refMatch[1];

    const refused = await mcpClient.callTool({ name: "file_upload", arguments: { paths: [secretFile], ref, tabId } });
    assert.match(refused.content[0].text, /^Error: Not in an allowed upload folder: /, `expected secret.txt to be refused: ${refused.content[0].text}`);
    assert.ok(refused.content[0].text.includes(secretFile), "expected the refusal to name the rejected path");
    assert.equal(refused.isError, true, "expected the refusal to be flagged isError");

    const uploaded = await mcpClient.callTool({ name: "file_upload", arguments: { paths: [allowedFile], ref, tabId } });
    assert.match(uploaded.content[0].text, /^Uploaded 1 file\(s\) to ref_\d+: /, `expected the Downloads upload to succeed: ${uploaded.content[0].text}`);
    assert.ok(uploaded.content[0].text.includes(fs.realpathSync(allowedFile)), "expected the success message to name the resolved path");

    // Bonus: confirm the file actually reached the page's own file input (its
    // change handler wrote the filename into a visible span), not just that
    // the tool claimed success.
    const confirm = await mcpClient.callTool({ name: "find", arguments: { query: "e2e-upload.txt", tabId } });
    assert.match(confirm.content[0].text, /e2e-upload\.txt/, `expected to find the uploaded filename reflected in the page: ${confirm.content[0].text}`);
  });

  it("7. resize_window: the reply shows the real sizes", { timeout: 15000 }, async () => {
    const res = await mcpClient.callTool({ name: "resize_window", arguments: { width: 1000, height: 700, tabId } });
    const text = res.content[0].text;
    const m = text.match(/^Resized window to (\d+)x(\d+)/);
    assert.ok(m, `unexpected resize_window reply: ${text}`);
    assert.equal(Number(m[1]), 1000, `expected width 1000, got reply: ${text}`);
    assert.equal(Number(m[2]), 700, `expected height 700, got reply: ${text}`);
  });

  it("8. read_network_requests after a redirect", { timeout: 15000 }, async () => {
    // Enables the Network domain for this tab; requests logged from here on.
    await mcpClient.callTool({ name: "read_network_requests", arguments: { tabId } });

    await mcpClient.callTool({ name: "navigate", arguments: { url: `${base}/redirect`, tabId } });

    // The literal space right after ".../redirect" in this pattern is what
    // keeps it from matching the "-target" hop's line too.
    const redirectHop = new RegExp(`GET ${reEscape(base + "/redirect")} → 302`);
    const targetHop = new RegExp(`GET ${reEscape(base + "/redirect-target")} → 200`);

    const text = await waitFor(
      async () => {
        const res = await mcpClient.callTool({ name: "read_network_requests", arguments: { tabId, urlPattern: "redirect" } });
        const t2 = res.content[0].text;
        return redirectHop.test(t2) && targetHop.test(t2) ? t2 : null;
      },
      { timeoutMs: 8000, intervalMs: 300 },
    );

    assert.match(text, redirectHop, `expected the redirect hop logged with status 302: ${text}`);
    assert.match(text, targetHop, `expected the final hop logged with status 200: ${text}`);
  });

  it("9. kill the native host during a wait of 5s: the call fails with LOST, then auto-reconnects", { timeout: 45000 }, async () => {
    const logPath = path.join(tempHome, ".config", "open-claude-in-chrome", "logs", "native-host.log");
    const before9 = lastLogEvent(logPath, "start");
    assert.ok(before9, "expected a prior native-host start event");
    const killPid = before9.pid;
    const cmd = cmdlineOf(killPid);
    assert.ok(
      cmd && cmd.includes("native-host.js") && cmd.includes(WORKTREE),
      `refusing to kill pid ${killPid}: command line does not look like our isolated native host (got: ${cmd})`,
    );

    const started = Date.now();
    const waitPromise = mcpClient.callTool({ name: "computer", arguments: { action: "wait", duration: 5, tabId } });
    await sleep(800); // let the request actually reach the extension before we cut the host
    process.kill(killPid, "SIGKILL");

    const waitResult = await waitPromise;
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 4500, `expected the call to fail promptly on kill, not after the full 5s wait (took ${elapsed}ms)`);
    assert.equal(waitResult.content[0].text, `Error: ${LOST}`, `expected the exact LOST message, got: ${waitResult.content[0].text}`);
    assert.equal(waitResult.isError, true, "expected the LOST reply to be flagged isError");

    // Nothing else restarts the native host: Chrome's own extension retries
    // connectNative() automatically (every ~2s), respawning it from the same
    // manifest/wrapper we registered once in before(). We only kill; we never
    // touch Chrome, the extension, or re-register anything here.
    const recovered = await waitFor(
      async () => {
        try {
          const res = await mcpClient.callTool({ name: "tabs_context_mcp", arguments: {} });
          const text = res.content[0].text;
          return text.startsWith("Error:") ? null : text;
        } catch {
          return null;
        }
      },
      { timeoutMs: 25000, intervalMs: 400 },
    );
    assert.ok(recovered, "expected a fresh tool call to succeed again after the reconnect, with no manual intervention");

    // Confirm it was a genuine restart (a new hub process), not the same one
    // somehow surviving: a fresh runId means the old hub-id has no owner left
    // anywhere to ever replay a response to, and the original request's
    // promise already settled exactly once above (a JS promise cannot
    // resettle) — so "not replayed" holds structurally, not just by luck.
    const after9 = lastLogEvent(logPath, "start");
    assert.ok(after9 && after9.pid !== killPid, `expected a new native-host pid after the kill, still saw ${killPid}`);
  });

  it("10. audit mode: session appears in the options page with a redacted action list", { timeout: 30000 }, async () => {

    const TOKEN_TYPED = "E2ESECRETTYPED";
    const TOKEN_QUERY = "E2ESECRETQ";
    const realDownloads = path.join(os.homedir(), "Downloads");
    const listAuditFiles = () =>
      fs.existsSync(realDownloads)
        ? new Set(fs.readdirSync(realDownloads).filter((f) => /^audit-session-.*\.json$/.test(f)))
        : new Set();
    const auditFilesBefore = listAuditFiles();

    // Deny downloads for the whole browser before the options page is even
    // opened (per the brief): an export attempt anywhere below must not be
    // able to write into any real folder either.
    await cdpSend("Browser.setDownloadBehavior", { behavior: "deny" });

    // The harness drives Chrome directly for this one page: the agent tools
    // have no way to open an extension's own options page.
    const { targetId } = await cdpSend("Target.createTarget", { url: `chrome-extension://${extensionId}/options.html` });
    const { sessionId } = await cdpSend("Target.attachToTarget", { targetId, flatten: true });
    await cdpSend("Page.enable", {}, sessionId);
    await cdpSend("Runtime.enable", {}, sessionId);
    const pEval = (expression, opts) => evalInPage(cdpSend, sessionId, expression, opts);

    // The page's scripts sit at the end of <body>, so the checkbox exists
    // before options.js has attached its "change" listener. A click then only
    // toggles the box, and options.js resets it to the stored value. By the
    // load event options.js has run. The element check keeps the new tab's
    // initial about:blank, already "complete", from passing.
    await waitFor(
      () => pEval("document.getElementById('audit-enabled') !== null && document.readyState === 'complete'"),
      { timeoutMs: 10000, intervalMs: 200 },
    );

    // "Prefer the real checkbox": a real .click() toggles it and fires the
    // page's own "change" listener, which is what actually persists the setting
    // (chrome.storage.local audit: { enabled: true, retentionDays: 7 }, 7 being
    // the <select>'s own default option).
    await pEval("document.getElementById('audit-enabled').click()");
    await waitFor(
      async () => {
        const stored = await pEval("chrome.storage.local.get('audit').then(r => JSON.stringify(r.audit || null))", { awaitPromise: true });
        return stored && stored.includes('"enabled":true') ? stored : null;
      },
      { timeoutMs: 10000, intervalMs: 200 },
    );

    // Through the normal MCP path: three real actions on the MCP tab, one
    // carrying a secret in the URL query, one typing a secret.
    await mcpClient.callTool({ name: "navigate", arguments: { url: `${base}/audit?token=${TOKEN_QUERY}`, tabId } });
    await mcpClient.callTool({ name: "computer", arguments: { action: "type", text: TOKEN_TYPED, tabId } });
    await mcpClient.callTool({ name: "computer", arguments: { action: "screenshot", tabId } });

    // renderSessions() only runs at load, so the session just created above
    // needs a reload to show up in the table.
    await cdpSend("Page.reload", {}, sessionId);
    await waitFor(() => pEval("document.getElementById('audit-enabled') !== null"), { timeoutMs: 10000, intervalMs: 200 });

    const expectedLabel = path.basename(WORKTREE);
    await waitFor(() => pEval("document.querySelector('#sessions-body button') !== null"), { timeoutMs: 10000, intervalMs: 300 });
    const rowLabel = await pEval("document.querySelector('#sessions-body button').textContent");
    assert.equal(rowLabel, expectedLabel, `expected the session row's label to be the client's label`);

    // Open the new session through the real UI: click its label button.
    await pEval("document.querySelector('#sessions-body button').click()");
    await waitFor(() => pEval("document.getElementById('session-detail').hidden === false"), { timeoutMs: 10000, intervalMs: 200 });

    // Read the store the same way the page itself just did (showSessionDetail
    // sets this exact module-level variable from AuditStore.getSession(id))
    // rather than re-deriving the session id ourselves.
    const sessionJson = await pEval("JSON.stringify(currentSession)");
    const full = JSON.parse(sessionJson);
    assert.ok(full && full.session, `expected currentSession to be populated: ${sessionJson}`);
    assert.ok(full.actions.some((a) => a.tool === "navigate"), `expected a navigate action: ${sessionJson}`);
    assert.ok(
      full.actions.some((a) => a.summary === `type [${TOKEN_TYPED.length} chars]`),
      `expected a "type [${TOKEN_TYPED.length} chars]" summary: ${sessionJson}`,
    );
    assert.ok(full.actions.some((a) => a.summary === "screenshot"), `expected a screenshot action: ${sessionJson}`);

    // No stored action or event contains either secret.
    assert.ok(!sessionJson.includes(TOKEN_TYPED), `stored audit data must never contain the typed secret: ${sessionJson}`);
    assert.ok(!sessionJson.includes(TOKEN_QUERY), `stored audit data must never contain the URL token: ${sessionJson}`);

    const hasPlayer = await pEval("document.getElementById('player-container').children.length > 0");
    assert.ok(hasPlayer, "expected the replay player to be mounted in #player-container");

    const newFiles = [...listAuditFiles()].filter((f) => !auditFilesBefore.has(f));
    assert.deepEqual(newFiles, [], `expected no new audit-session-*.json in ${realDownloads}, found: ${newFiles.join(", ")}`);
  });
});
