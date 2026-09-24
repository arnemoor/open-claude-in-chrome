import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { chromeAvailable, launchChrome, openPage, injectContentScript } from "./harness/browser.mjs";

const CONTENT = path.join(import.meta.dirname, "..", "extension", "content.js");
const NAMES = ["title", "placeholder", "alt", "children", "tagName", "textContent", "nodeType", "disabled", "id",
  "getAttribute", "closest", "matches", "shadowRoot", "getBoundingClientRect", "tabIndex", "onclick",
  "contentEditable", "offsetParent", "action", "method", "name", "value", "type"];

let browser;
before(async () => { if (chromeAvailable) browser = await launchChrome(); }, { timeout: 30000 });
after(() => browser?.close());

test("find and read_page survive every clobbering control name", { skip: !chromeAvailable, timeout: 30000 }, async () => {
  for (const name of NAMES) {
    const page = await openPage(browser, { html: `<form aria-label="F"><input name="${name}" placeholder="field"><button>Go</button></form>` });
    const cs = await injectContentScript(page, CONTENT);
    const tree = await cs.invoke({ type: "generateAccessibilityTree", options: {} });
    assert.equal(typeof tree.result, "string", name);
    assert.match(tree.result, /button "Go"/, name);
    assert.doesNotMatch(tree.result, /form "F" \[ref_\d+\] disabled/, name);
    const found = await cs.invoke({ type: "findElements", query: "go" });
    assert.ok(found.result.some((r) => r.name === "Go"), name);
  }
});

// content.js only ever runs in an isolated world (see manifest content_scripts / the executeScript
// call in background.js), where Chrome does not expose document-level named properties: a same-page
// <form name="title">/<img name="body"> cannot override document.title/document.body there, so these
// two tests already pass pre-fix and would keep passing even if the dom.docTitle()/dom.docBody()
// routing were removed. They document a defense that would only matter in the main world, not a
// regression test against today's runtime.
test("get_page_text reads the real title when a form is named title", { skip: !chromeAvailable, timeout: 20000 }, async () => {
  const page = await openPage(browser, { html: `<title>Real</title><form name="title"></form><p>body text</p>` });
  const cs = await injectContentScript(page, CONTENT);
  assert.equal(JSON.parse((await cs.invoke({ type: "getPageText" })).result).title, "Real");
});

test("read_page walks the real body when an image is named body", { skip: !chromeAvailable, timeout: 20000 }, async () => {
  const page = await openPage(browser, { html: `<img name="body" alt="x"><button>One</button><button>Two</button>` });
  const cs = await injectContentScript(page, CONTENT);
  const tree = (await cs.invoke({ type: "generateAccessibilityTree", options: {} })).result;
  assert.match(tree, /button "One"/);
  assert.match(tree, /button "Two"/);
});

test("an element named like the load guard does not disable the script", { skip: !chromeAvailable, timeout: 20000 }, async () => {
  const page = await openPage(browser, { html: `<div id="__unblockedChromeLoaded"></div><button>Go</button>` });
  const cs = await injectContentScript(page, CONTENT);
  assert.ok((await cs.invoke({ type: "findElements", query: "go" })).result.length > 0);
});

// The sweep above puts aria-label="F" on the form, which makes getAccessibleName return "F" before it
// ever reaches placeholder/title/alt/id/closest — so most of the 23 names never actually exercise the
// code path they're named for. A bare form (no aria-label) forces every fallback branch to run.
test("find and read_page survive every clobbering control name on a bare form", { skip: !chromeAvailable, timeout: 30000 }, async () => {
  for (const name of NAMES) {
    const page = await openPage(browser, { html: `<form><input name="${name}" placeholder="field"><button>Go</button></form>` });
    const cs = await injectContentScript(page, CONTENT);
    const tree = await cs.invoke({ type: "generateAccessibilityTree", options: {} });
    assert.equal(typeof tree.result, "string", name);
    assert.match(tree.result, /button "Go"/, name);
    assert.doesNotMatch(tree.result, /disabled/, name);
    const found = await cs.invoke({ type: "findElements", query: "go" });
    assert.ok(found.result.some((r) => r.name === "Go"), name);
  }
});

test("read_page and find survive inline SVG", { skip: !chromeAvailable, timeout: 20000 }, async () => {
  const page = await openPage(browser, { html: `<button>Go</button><svg width="10" height="10"><circle cx="5" cy="5" r="4"/></svg>` });
  const cs = await injectContentScript(page, CONTENT);
  const tree = await cs.invoke({ type: "generateAccessibilityTree", options: {} });
  assert.match(tree.result, /button "Go"/);
  const found = await cs.invoke({ type: "findElements", query: "go" });
  assert.ok(found.result.some((r) => r.name === "Go"));
});

test("read_page and find survive inline MathML", { skip: !chromeAvailable, timeout: 20000 }, async () => {
  const page = await openPage(browser, { html: `<button>Go</button><math><mi>x</mi></math>` });
  const cs = await injectContentScript(page, CONTENT);
  const tree = await cs.invoke({ type: "generateAccessibilityTree", options: {} });
  assert.match(tree.result, /button "Go"/);
  const found = await cs.invoke({ type: "findElements", query: "go" });
  assert.ok(found.result.some((r) => r.name === "Go"));
});

// A <select> inside <svg> parses as a "select" in the SVG namespace, not HTMLSelectElement, so
// tag-name equality alone can't be trusted to mean el.options exists.
test("read_page and find survive a <select> inside <svg> (foreign-namespace select)", { skip: !chromeAvailable, timeout: 20000 }, async () => {
  const page = await openPage(browser, { html: `<svg><select><option>a</option></select></svg><button>Go</button>` });
  const cs = await injectContentScript(page, CONTENT);
  const tree = await cs.invoke({ type: "generateAccessibilityTree", options: {} });
  assert.equal(typeof tree.result, "string");
  assert.match(tree.result, /button "Go"/);
  const found = await cs.invoke({ type: "findElements", query: "go" });
  assert.ok(found.result.some((r) => r.name === "Go"));
});

test("filter interactive lists only real controls, not every element", { skip: !chromeAvailable, timeout: 20000 }, async () => {
  const page = await openPage(browser, { html: `<div><p>Hello</p><span>x</span><section><h2>Head</h2></section><button>Go</button><a href="#a">Link</a></div>` });
  const cs = await injectContentScript(page, CONTENT);
  const tree = (await cs.invoke({ type: "generateAccessibilityTree", options: { filter: "interactive" } })).result;
  const refCount = (tree.match(/\[ref_\d+\]/g) || []).length;
  assert.equal(refCount, 2, tree);
  assert.match(tree, /button "Go"/);
  assert.match(tree, /link "Link"/);
});

test('contenteditable="TRUE" (any case) counts as interactive', { skip: !chromeAvailable, timeout: 20000 }, async () => {
  const page = await openPage(browser, { html: `<div contenteditable="TRUE" aria-label="Editor"></div>` });
  const cs = await injectContentScript(page, CONTENT);
  const tree = (await cs.invoke({ type: "generateAccessibilityTree", options: { filter: "interactive" } })).result;
  assert.match(tree, /"Editor"/);
});

test("get_page_text survives a clobbered <form> content source", { skip: !chromeAvailable, timeout: 20000 }, async () => {
  for (const html of [
    `<form class="content"><input name="cloneNode"><p>hello</p></form>`,
    `<form id="content"><input name="querySelectorAll"><p>hello</p></form>`,
  ]) {
    const page = await openPage(browser, { html });
    const cs = await injectContentScript(page, CONTENT);
    const result = JSON.parse((await cs.invoke({ type: "getPageText" })).result);
    assert.match(result.text, /hello/, html);
  }
});

test('find("submit") matches a plain <button>\'s implicit type', { skip: !chromeAvailable, timeout: 20000 }, async () => {
  const page = await openPage(browser, { html: `<form><input placeholder="q"><button>Send</button></form>` });
  const cs = await injectContentScript(page, CONTENT);
  const found = await cs.invoke({ type: "findElements", query: "submit" });
  assert.ok(found.result.some((r) => r.name === "Send"));
});
