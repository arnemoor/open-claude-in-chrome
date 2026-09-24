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
async function withRecorderPage(fn, { skipRecorderEval = false } = {}) {
  const server = http.createServer((req, res) => {
    res.end(`<!doctype html><title>audit-recorder test</title><input id="t"><input id="p" type="password"><div id="c" contenteditable="true"></div><div id="ce" contenteditable="true"><p id="ce-p">existing</p></div><input type="hidden" id="h1" name="csrf" value="HIDDENLOAD111"><input type="hidden" id="h2" value="">`);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  try {
    const page = await openPage(browser, { url: `http://127.0.0.1:${port}/` });
    const { frameTree } = await page.send("Page.getFrameTree");
    const { executionContextId } = await page.send("Page.createIsolatedWorld", { frameId: frameTree.frame.id, worldName: "ocic-recorder" });
    const world = (expr) => evaluate(page.send, expr, executionContextId);
    // sendMessage returns a real (resolved) Promise, matching Chrome's MV3
    // Promise-based signature: recorder.js chains .catch() onto it (M5).
    await world(`globalThis.sent = []; globalThis.chrome = { runtime: { id: "testextensionid", sendMessage(msg) { globalThis.sent.push(msg); return Promise.resolve({ ok: true }); } } };`);
    await world(VENDOR_JS);
    if (!skipRecorderEval) await world(RECORDER_JS);
    await fn(page, world);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

// Finds an rrweb node's id by its DOM "id" attribute, walking a full snapshot's
// (or an adds entry's) node tree.
function findNodeId(node, domId) {
  if (!node || typeof node !== "object") return null;
  if (node.attributes && node.attributes.id === domId) return node.id;
  for (const child of node.childNodes || []) {
    const found = findNodeId(child, domId);
    if (found != null) return found;
  }
  return null;
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
    // I3: with the plan's mandated sampling.input:"last", rrweb only records a
    // value on "change" (which fires on blur), not on every keystroke — without
    // this, #p is never committed and the assertions below can never fail even
    // if password masking were removed entirely.
    await page.evaluate(`document.querySelector("#p").blur()`);
    await sleep(1500);

    const sentJson = await world("JSON.stringify(globalThis.sent)");
    assert.doesNotMatch(sentJson, /hunter2/);
    assert.doesNotMatch(sentJson, /s3cret/);

    const sent = JSON.parse(sentJson);
    assert.ok(sent.length > 0, "expected at least one flushed batch");
    assert.ok(sent.every((m) => m.type === "ocic_audit_events"), "expected every message to carry the ocic_audit_events type");
    const events = sent.flatMap((m) => m.events);
    const fullSnapshot = events.find((e) => e.type === 2);
    assert.ok(fullSnapshot, `expected a full snapshot (type 2) event among: ${events.map((e) => e.type)}`);

    // I3: assert POSITIVELY that each field produced its own masked input event
    // — the doesNotMatch checks above pass trivially if a field's value never
    // reached the wire at all, which is exactly the bug this closes for #p.
    const tId = findNodeId(fullSnapshot.data.node, "t");
    const pId = findNodeId(fullSnapshot.data.node, "p");
    assert.ok(tId != null && pId != null, "expected to find #t and #p in the full snapshot");
    const inputEvents = events.filter((e) => e.type === 3 && e.data?.source === 5);
    for (const [label, id] of [["#t", tId], ["#p", pId]]) {
      const ev = inputEvents.find((e) => e.data.id === id);
      assert.ok(ev, `expected an input event for ${label} (node id ${id}), got: ${JSON.stringify(inputEvents)}`);
      assert.match(ev.data.text, /^\*+$/, `expected a masked value for ${label}, got ${JSON.stringify(ev.data)}`);
    }
  });
});

// CE (Review Focus 5 gap from Task 16): a contenteditable region is a real text
// input just as much as <input>/<textarea> — maskAllInputs only covers form
// controls, so anything typed into a contenteditable div (a rich-text editor, a
// chat box) went out unmasked. #ce-p is nested one level inside #ce itself, to
// prove the mask reaches nested text, not just the contenteditable host element.
test("masks text typed into a contenteditable region, including nested elements", { skip: !chromeAvailable, timeout: 20000 }, async () => {
  await withRecorderPage(async (page, world) => {
    // <p> itself isn't focusable; focus the contenteditable host, then move the
    // caret into the nested <p> via Selection/Range so Input.insertText lands there.
    await page.evaluate(`
      document.getElementById("ce").focus();
      const range = document.createRange();
      range.selectNodeContents(document.getElementById("ce-p"));
      range.collapse(false);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    `);
    await page.send("Input.insertText", { text: "hunter2" });
    await sleep(1500);

    const sentJson = await world("JSON.stringify(globalThis.sent)");
    assert.doesNotMatch(sentJson, /hunter2/);

    // Still a real recording, not a blank/blocked element: a full snapshot must
    // have gone out, same shape as the masked-input test above.
    const sent = JSON.parse(sentJson);
    const events = sent.flatMap((m) => m.events);
    assert.ok(events.some((e) => e.type === 2), `expected a full snapshot (type 2) event among: ${events.map((e) => e.type)}`);
  });
});

test("masks text typed into an empty contenteditable element", { skip: !chromeAvailable, timeout: 20000 }, async () => {
  await withRecorderPage(async (page, world) => {
    await page.evaluate(`document.querySelector("#c").focus()`);
    await page.send("Input.insertText", { text: "hunter2" });
    await sleep(1500);

    const sentJson = await world("JSON.stringify(globalThis.sent)");
    assert.doesNotMatch(sentJson, /hunter2/);
  });
});

// I1: hidden inputs (a CSRF token present at load, one set by a page script,
// one added later) are blocked outright by blockSelector, so their raw value
// never reaches the wire at all — unlike a cleared password (a *visible* field
// type), which is covered instead by the worker-side walker (test/audit-redact
// .test.mjs's redactEvents tests), since blockSelector only targets
// input[type=hidden].
test("hidden inputs never appear, present at load, set by script, or added later", { skip: !chromeAvailable, timeout: 20000 }, async () => {
  await withRecorderPage(async (page, world) => {
    await page.evaluate(`
      document.getElementById("h2").value = "HIDDENSCRIPT999";
      const h3 = document.createElement("input");
      h3.type = "hidden";
      h3.id = "h3";
      h3.value = "LATEHIDDEN1414";
      document.body.appendChild(h3);
    `);
    await sleep(1500);

    const sentJson = await world("JSON.stringify(globalThis.sent)");
    assert.doesNotMatch(sentJson, /HIDDENLOAD111/, "present at load");
    assert.doesNotMatch(sentJson, /HIDDENSCRIPT999/, "set by a page script");
    assert.doesNotMatch(sentJson, /LATEHIDDEN1414/, "added later");

    // Still a real recording, not a blank page.
    const events = JSON.parse(sentJson).flatMap((m) => m.events);
    assert.ok(events.some((e) => e.type === 2), `expected a full snapshot (type 2) event among: ${events.map((e) => e.type)}`);
  });
});

// M3: a back/forward-cache restore resumes the same recorder instance (the
// page's JS state survives bfcache) with no full snapshot of its own, so the
// stored stream would otherwise have no base for the replayer to apply later
// increments onto. Dispatched directly rather than via a real navigation: bfcache
// eligibility in headless Chrome is unreliable to depend on for a unit test —
// this instead pins recorder.js's own reaction to the event it needs to react to.
test("a persisted pageshow event triggers a fresh full snapshot", { skip: !chromeAvailable, timeout: 20000 }, async () => {
  await withRecorderPage(async (page, world) => {
    await sleep(1500); // let the initial full snapshot flush
    await world("globalThis.sent = [];");

    await world(`window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: false }))`);
    await sleep(1500);
    const notPersisted = JSON.parse(await world("JSON.stringify(globalThis.sent)")).flatMap((m) => m.events);
    assert.ok(!notPersisted.some((e) => e.type === 2), "a non-persisted pageshow must not force a resnapshot");

    await world("globalThis.sent = [];");
    await world(`window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }))`);
    await sleep(1500);
    const persisted = JSON.parse(await world("JSON.stringify(globalThis.sent)")).flatMap((m) => m.events);
    assert.ok(persisted.some((e) => e.type === 2), `expected a fresh full snapshot after a persisted pageshow, got types: ${persisted.map((e) => e.type)}`);
  });
});

// M5: setting the idempotence key only after record() succeeds means a
// transient failure doesn't permanently block a later, working retry.
test("a failed record() call does not permanently block a retry", { skip: !chromeAvailable, timeout: 20000 }, async () => {
  await withRecorderPage(async (page, world) => {
    await world(`
      globalThis.__realRecord = globalThis.rrwebRecord.record;
      globalThis.rrwebRecord.record = () => { throw new Error("boom"); };
    `);
    await world(`try { ${RECORDER_JS} } catch {}`);
    const keySetAfterFailure = await world(`!!globalThis[Symbol.for("ocic.audit.recorder")]`);
    assert.equal(keySetAfterFailure, false, "a failed record() call must not set the idempotence key");

    await world(`globalThis.rrwebRecord.record = globalThis.__realRecord;`);
    await world(RECORDER_JS); // retry, now with the real record()

    await page.evaluate(`document.querySelector("#t").focus()`);
    await page.send("Input.insertText", { text: "hunter2" });
    await sleep(1500);

    const sentJson = await world("JSON.stringify(globalThis.sent)");
    assert.doesNotMatch(sentJson, /hunter2/);
    const events = JSON.parse(sentJson).flatMap((m) => m.events);
    assert.ok(events.some((e) => e.type === 2), "expected the retry to actually start recording (a full snapshot)");
  }, { skipRecorderEval: true });
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
