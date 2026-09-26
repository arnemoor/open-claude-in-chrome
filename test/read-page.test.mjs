import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { chromeAvailable, launchChrome, openPage, injectContentScript } from "./harness/browser.mjs";

const CONTENT = path.join(import.meta.dirname, "..", "extension", "content.js");

let browser;
before(async () => { if (chromeAvailable) browser = await launchChrome(); }, { timeout: 30000 });
after(() => browser?.close());

// These pin what the read_page description in host/mcp-server.js promises, so a change to
// isVisible or to the max_chars cut-off shows up here instead of as a silently wrong description.
test("read_page lists elements outside the viewport and leaves out elements hidden with CSS", { skip: !chromeAvailable, timeout: 20000 }, async () => {
  const page = await openPage(browser, { html: `<button>Shown</button>
    <button style="display:none">DisplayNone</button>
    <div style="display:none"><button>InsideDisplayNone</button></div>
    <button style="visibility:hidden">VisibilityHidden</button>
    <input type="file" style="display:none" aria-label="HiddenUpload">
    <div style="height:5000px"></div>
    <button id="below">BelowTheFold</button>` });
  assert.ok(await page.evaluate("document.getElementById('below').getBoundingClientRect().top > innerHeight"),
    "BelowTheFold must start outside the viewport, or this test proves nothing about it");
  const cs = await injectContentScript(page, CONTENT);
  for (const filter of ["all", "interactive"]) {
    const tree = (await cs.invoke({ type: "generateAccessibilityTree", options: { filter } })).result;
    assert.match(tree, /button "Shown"/, filter);
    assert.match(tree, /button "BelowTheFold"/, filter);
    for (const hidden of ["DisplayNone", "InsideDisplayNone", "VisibilityHidden", "HiddenUpload"]) {
      assert.doesNotMatch(tree, new RegExp(`"${hidden}"`), `${filter}: ${hidden}`);
    }
  }
});

test("read_page cuts output off at max_chars instead of failing", { skip: !chromeAvailable, timeout: 20000 }, async () => {
  const page = await openPage(browser, { html: Array.from({ length: 50 }, (_, i) => `<button>Button ${i}</button>`).join("") });
  const cs = await injectContentScript(page, CONTENT);
  const tree = (await cs.invoke({ type: "generateAccessibilityTree", options: { max_chars: 200 } })).result;
  assert.equal(typeof tree, "string");
  assert.match(tree, /button "Button 0"/);
  assert.ok(tree.endsWith("\n... (truncated)"), tree);
  assert.equal(tree.length, 200 + "\n... (truncated)".length);
});
