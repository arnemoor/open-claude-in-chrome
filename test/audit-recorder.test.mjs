// Exercises extension/audit/recorder.js (the rrweb-based DOM replay recorder) against
// real Chrome: typed values (including a password field) must never appear in what it
// sends, a full snapshot must still be captured, and evaluating the script twice in the
// same document must not start a second recorder.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { chromeAvailable, launchChrome, openPage, evaluate } from "./harness/browser.mjs";

const EXT = path.join(import.meta.dirname, "..", "extension");
const VENDOR_JS = fs.readFileSync(path.join(EXT, "vendor", "rrweb-record.min.js"), "utf8");
const RECORDER_JS = fs.readFileSync(path.join(EXT, "audit", "recorder.js"), "utf8");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let browser;
before(async () => { if (chromeAvailable) browser = await launchChrome(); }, { timeout: 30000 });
after(() => browser?.close());

// Serves a fresh local page (a real HTTP origin, like audit-store.test.mjs's store.js
// tests, rather than a data: URL) with two fields, then evaluates the vendor bundle and
// recorder.js in a fresh isolated world — the same two files, same world, and same order
// ensureRecorder() (audit.js) injects them with in production. A stub
// chrome.runtime.sendMessage pushes each flushed batch into globalThis.sent instead of
// actually relaying it to a background page.
async function withRecorderPage(fn) {
  const server = http.createServer((req, res) => {
    res.end(`<!doctype html><title>audit-recorder test</title><input id="t"><input id="p" type="password">`);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  try {
    const page = await openPage(browser, { url: `http://127.0.0.1:${port}/` });
    const { frameTree } = await page.send("Page.getFrameTree");
    const { executionContextId } = await page.send("Page.createIsolatedWorld", { frameId: frameTree.frame.id, worldName: "ocic-recorder" });
    const world = (expr) => evaluate(page.send, expr, executionContextId);
    await world(`globalThis.sent = []; globalThis.chrome = { runtime: { id: "testextensionid", sendMessage(msg) { globalThis.sent.push(msg); } } };`);
    await world(VENDOR_JS);
    await world(RECORDER_JS);
    await fn(page, world);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

// Focuses `selector` in the page's main world (isolated worlds share the real DOM, so
// this focuses the same element recorder.js's listeners see in the isolated world),
// inserts `text` the way CDP-driven typing does (extension/background.js's own "type"
// action), then blurs. The blur means repeating this on the same field twice produces
// the same focus/input/blur shape both times, instead of the second focus() being a
// no-op because the field never lost focus after the first call.
async function typeInto(page, selector, text) {
  await page.evaluate(`document.querySelector(${JSON.stringify(selector)}).focus()`);
  await page.send("Input.insertText", { text });
  await page.evaluate(`document.querySelector(${JSON.stringify(selector)}).blur()`);
}

test("masks typed input and a password field, but still emits a full snapshot", { skip: !chromeAvailable, timeout: 20000 }, async () => {
  await withRecorderPage(async (page, world) => {
    await page.evaluate(`document.querySelector("#t").focus()`);
    await page.send("Input.insertText", { text: "hunter2" });
    await page.evaluate(`document.querySelector("#p").focus()`);
    await page.send("Input.insertText", { text: "s3cret" });
    await sleep(1500);

    const sentJson = await world("JSON.stringify(globalThis.sent)");
    assert.doesNotMatch(sentJson, /hunter2/);
    assert.doesNotMatch(sentJson, /s3cret/);

    const sent = JSON.parse(sentJson);
    assert.ok(sent.length > 0, "expected at least one flushed batch");
    assert.ok(sent.every((m) => m.type === "ocic_audit_events"), "expected every message to carry the ocic_audit_events type");
    const events = sent.flatMap((m) => m.events);
    assert.ok(events.some((e) => e.type === 2), `expected a full snapshot (type 2) event among: ${events.map((e) => e.type)}`);
  });
});

test("evaluating recorder.js a second time does not start a second recorder", { skip: !chromeAvailable, timeout: 20000 }, async () => {
  await withRecorderPage(async (page, world) => {
    // Let the initial record()-start full snapshot flush out, then start both
    // sequences from an equally empty buffer so their counts are directly comparable.
    await sleep(1500);
    await world("globalThis.sent = [];");

    await typeInto(page, "#t", "abc");
    await sleep(1500);
    const firstCount = JSON.parse(await world("JSON.stringify(globalThis.sent)")).flatMap((m) => m.events).length;
    assert.ok(firstCount > 0, "expected at least one event from the first sequence");

    // A second evaluation must hit the idempotence guard: no second record() call, so
    // no duplicate listeners and no second full snapshot.
    await world("globalThis.sent = [];");
    await world(RECORDER_JS);

    await typeInto(page, "#t", "abc");
    await sleep(1500);
    const secondCount = JSON.parse(await world("JSON.stringify(globalThis.sent)")).flatMap((m) => m.events).length;

    assert.equal(secondCount, firstCount, `re-evaluating recorder.js should not change the event rate (first ${firstCount}, second ${secondCount})`);
  });
});
