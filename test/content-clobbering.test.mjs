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
