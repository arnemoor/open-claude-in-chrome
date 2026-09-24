import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { loadBackground } from "./harness/fake-chrome.mjs";
import { chromeAvailable, launchChrome, openPage, injectContentScript } from "./harness/browser.mjs";

const CONTENT = path.join(import.meta.dirname, "..", "extension", "content.js");
let browser;
before(async () => { if (chromeAvailable) browser = await launchChrome(); });
after(() => browser?.close());

async function setup(html) {
  const page = await openPage(browser, { html: `<body style="margin:0">${html}<script>window.clicked = [];document.addEventListener("click", (e) => clicked.push(e.target.id || e.target.tagName), true);</script></body>` });
  const cs = await injectContentScript(page, CONTENT);
  const bg = await loadBackground({ page, content: cs });
  const refOf = async (q) => (await cs.invoke({ type: "findElements", query: q })).result.find((r) => r.name === q);
  return { page, cs, bg, refOf };
}

test("an off-screen ref is scrolled into view and clicked for real", { skip: !chromeAvailable }, async () => {
  const { page, bg, refOf } = await setup(`<div style="height:3000px"></div><button id="far">Far</button>`);
  const far = await refOf("Far");
  assert.equal(far.inViewport, false);
  const r = await bg.handlers.computer({ action: "left_click", ref: far.ref, tabId: bg.tabId });
  assert.match(r.content[0].text, /^Clicked at \(\d+, \d+\) on button#far "Far" after scrolling it into view/);
  assert.deepEqual(await page.evaluate("clicked"), ["far"]);
});

test("find flags off-screen results", { skip: !chromeAvailable }, async () => {
  const { bg } = await setup(`<div style="height:3000px"></div><button>Far</button>`);
  const r = await bg.handlers.find({ query: "Far", tabId: bg.tabId });
  assert.match(r.content[0].text, /\[off-screen, click by ref to scroll it into view\]/);
});

test("a covered target is clicked but the cover is named", { skip: !chromeAvailable }, async () => {
  const { bg, refOf } = await setup(`<button id="under" style="position:absolute;top:10px;left:10px">Under</button><div id="cover" style="position:fixed;inset:0;background:rgba(0,0,0,.1)"></div>`);
  const r = await bg.handlers.computer({ action: "left_click", ref: (await refOf("Under")).ref, tabId: bg.tabId });
  assert.match(r.content[0].text, /Warning: The click point is covered by div#cover/);
});

test("a coordinate outside the viewport is refused without dispatching input", { skip: !chromeAvailable }, async () => {
  const { bg } = await setup(`<p>x</p>`);
  const r = await bg.handlers.computer({ action: "left_click", coordinate: [10, 5000], tabId: bg.tabId });
  assert.match(r.content[0].text, /^Coordinate \(10, 5000\) is outside the viewport \(\d+x\d+\)\. Scroll first or use a ref\./);
  assert.equal(bg.calls.filter((c) => c[1] === "Input.dispatchMouseEvent").length, 0);
});

test("a coordinate click reports what it hit", { skip: !chromeAvailable }, async () => {
  const { bg } = await setup(`<button id="b" style="position:absolute;top:0;left:0;width:100px;height:40px">Hit me</button>`);
  const r = await bg.handlers.computer({ action: "left_click", coordinate: [50, 20], tabId: bg.tabId });
  assert.match(r.content[0].text, /^Clicked at \(50, 20\) on button#b "Hit me"/);
});

test("a label with a disabled control carries a warning", { skip: !chromeAvailable }, async () => {
  const { bg, refOf } = await setup(`<label id="l" for="c" style="display:block;width:200px">Accept</label><input id="c" type="checkbox" disabled>`);
  const r = await bg.handlers.computer({ action: "left_click", ref: (await refOf("Accept")).ref, tabId: bg.tabId });
  assert.match(r.content[0].text, /This label's control is disabled\./);
});

test("scroll_to by ref works and reports where the element is", { skip: !chromeAvailable }, async () => {
  const { page, bg, refOf } = await setup(`<div style="height:3000px"></div><button>Far</button>`);
  const r = await bg.handlers.computer({ action: "scroll_to", ref: (await refOf("Far")).ref, tabId: bg.tabId });
  assert.match(r.content[0].text, /^Scrolled ref_\d+ into view at \(\d+, \d+\)\./);
  assert.ok((await page.evaluate("scrollY")) > 2000);
});

test("targets inside shadow DOM are hit, not reported as covered", { skip: !chromeAvailable }, async () => {
  const { bg, cs } = await setup(`<div id="host"></div><script>host.attachShadow({mode:"open"}).innerHTML = '<button id="inner">Shadow</button>';</script>`);
  const ref = (await cs.invoke({ type: "findElements", query: "shadow" })).result[0].ref;
  const r = await bg.handlers.computer({ action: "left_click", ref, tabId: bg.tabId });
  assert.doesNotMatch(r.content[0].text, /Warning/);
});
