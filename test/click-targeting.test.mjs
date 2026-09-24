import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { loadBackground } from "./harness/fake-chrome.mjs";
import { chromeAvailable, launchChrome, openPage, injectContentScript } from "./harness/browser.mjs";

const CONTENT = path.join(import.meta.dirname, "..", "extension", "content.js");
let browser;
before(async () => { if (chromeAvailable) browser = await launchChrome(); }, { timeout: 30000 });
after(() => browser?.close());

async function setup(html) {
  const page = await openPage(browser, { html: `<body style="margin:0">${html}<script>window.clicked = [];document.addEventListener("click", (e) => clicked.push(e.target.id || e.target.tagName), true);</script></body>` });
  const cs = await injectContentScript(page, CONTENT);
  const bg = await loadBackground({ page, content: cs });
  const refOf = async (q) => (await cs.invoke({ type: "findElements", query: q })).result.find((r) => r.name === q);
  return { page, cs, bg, refOf };
}

test("an off-screen ref is scrolled into view and clicked for real", { skip: !chromeAvailable, timeout: 20000 }, async () => {
  const { page, bg, refOf } = await setup(`<div style="height:3000px"></div><button id="far">Far</button>`);
  const far = await refOf("Far");
  assert.equal(far.inViewport, false);
  const r = await bg.handlers.computer({ action: "left_click", ref: far.ref, tabId: bg.tabId });
  assert.match(r.content[0].text, /^Clicked at \(\d+, \d+\) on button#far "Far" after scrolling it into view/);
  assert.deepEqual(await page.evaluate("clicked"), ["far"]);
});

test("find flags off-screen results", { skip: !chromeAvailable, timeout: 20000 }, async () => {
  const { bg } = await setup(`<div style="height:3000px"></div><button>Far</button>`);
  const r = await bg.handlers.find({ query: "Far", tabId: bg.tabId });
  assert.match(r.content[0].text, /\[off-screen, click by ref to scroll it into view\]/);
});

test("a covered target is clicked but the cover is named", { skip: !chromeAvailable, timeout: 20000 }, async () => {
  const { bg, refOf } = await setup(`<button id="under" style="position:absolute;top:10px;left:10px">Under</button><div id="cover" style="position:fixed;inset:0;background:rgba(0,0,0,.1)"></div>`);
  const r = await bg.handlers.computer({ action: "left_click", ref: (await refOf("Under")).ref, tabId: bg.tabId });
  assert.match(r.content[0].text, /Warning: The click point is covered by div#cover/);
  // N2: the retry scroll is a no-op on this page (nothing to scroll — it's exactly one
  // viewport tall), so the reply must not falsely claim it scrolled anything into view.
  assert.doesNotMatch(r.content[0].text, /after scrolling/);
});

test("a coordinate outside the viewport is refused without dispatching input", { skip: !chromeAvailable, timeout: 20000 }, async () => {
  const { bg } = await setup(`<p>x</p>`);
  const r = await bg.handlers.computer({ action: "left_click", coordinate: [10, 5000], tabId: bg.tabId });
  assert.match(r.content[0].text, /^Coordinate \(10, 5000\) is outside the viewport \(\d+x\d+\)\. Scroll first or use a ref\./);
  assert.equal(bg.calls.filter((c) => c[1] === "Input.dispatchMouseEvent").length, 0);
});

test("a coordinate click reports what it hit", { skip: !chromeAvailable, timeout: 20000 }, async () => {
  const { bg } = await setup(`<button id="b" style="position:absolute;top:0;left:0;width:100px;height:40px">Hit me</button>`);
  const r = await bg.handlers.computer({ action: "left_click", coordinate: [50, 20], tabId: bg.tabId });
  assert.match(r.content[0].text, /^Clicked at \(50, 20\) on button#b "Hit me"/);
});

test("a label with a disabled control carries a warning", { skip: !chromeAvailable, timeout: 20000 }, async () => {
  const { bg, refOf } = await setup(`<label id="l" for="c" style="display:block;width:200px">Accept</label><input id="c" type="checkbox" disabled>`);
  const r = await bg.handlers.computer({ action: "left_click", ref: (await refOf("Accept")).ref, tabId: bg.tabId });
  assert.match(r.content[0].text, /This label's control is disabled\./);
});

test("scroll_to by ref works and reports where the element is", { skip: !chromeAvailable, timeout: 20000 }, async () => {
  const { page, bg, refOf } = await setup(`<div style="height:3000px"></div><button>Far</button>`);
  const r = await bg.handlers.computer({ action: "scroll_to", ref: (await refOf("Far")).ref, tabId: bg.tabId });
  assert.match(r.content[0].text, /^Scrolled ref_\d+ into view at \(\d+, \d+\)\./);
  assert.ok((await page.evaluate("scrollY")) > 2000);
});

test("targets inside shadow DOM are hit, not reported as covered", { skip: !chromeAvailable, timeout: 20000 }, async () => {
  const { bg, cs } = await setup(`<div id="host"></div><script>host.attachShadow({mode:"open"}).innerHTML = '<button id="inner">Shadow</button>';</script>`);
  const found = await cs.invoke({ type: "findElements", query: "shadow" });
  const ref = found.result.find((r) => r.role === "button" && r.name === "Shadow").ref;
  const r = await bg.handlers.computer({ action: "left_click", ref, tabId: bg.tabId });
  assert.match(r.content[0].text, /^Clicked at \(\d+, \d+\) on button#inner "Shadow"\.$/);
});

// I1: on a page where the content script cannot run at all (a certificate interstitial, a
// network error page), probePoint's message never gets a response. A coordinate click must
// still go through — with whatever hit info is available, or none — rather than throwing or
// refusing as if the coordinate were off-screen. No real Chrome needed: loadBackground with no
// `content` makes chrome.tabs.sendMessage always reject, exactly like an unreachable page.
test("a coordinate click still works when no content script can run", async () => {
  const bg = await loadBackground({});
  const r = await bg.handlers.computer({ action: "left_click", coordinate: [100, 200], tabId: bg.tabId });
  assert.equal(r.content[0].text, "Clicked at (100, 200).");
  assert.equal(bg.calls.filter((c) => c[1] === "Input.dispatchMouseEvent").length, 3);
});

// I4: a target inside a small scrolling container can be within the page's own viewport
// (getBoundingClientRect still reports its full, un-clipped position) while being invisible
// because its own container hasn't scrolled it into view. The click must scroll the container
// and land on the real target, not on whatever is painted behind the clipped-away element.
test("a target clipped by its own vertical scroll container is scrolled within it and clicked", { skip: !chromeAvailable, timeout: 20000 }, async () => {
  const { page, cs, bg } = await setup(`
    <div id="container" style="height:100px;overflow:auto">
      <div style="height:400px"></div>
      <button id="target">Target</button>
    </div>
    <div id="below" style="height:500px">Below</div>`);
  // The container's own fallback name (no accessible name of its own, so findElements falls
  // back to its full text content) also happens to equal the button's text, "Target" — filter
  // by role too so this picks the button, not its ancestor.
  const found = await cs.invoke({ type: "findElements", query: "target" });
  const ref = found.result.find((r) => r.role === "button" && r.name === "Target").ref;
  const r = await bg.handlers.computer({ action: "left_click", ref, tabId: bg.tabId });
  assert.match(r.content[0].text, /^Clicked at \(\d+, \d+\) on button#target "Target"/);
  assert.doesNotMatch(r.content[0].text, /Warning/);
  assert.deepEqual(await page.evaluate("clicked"), ["target"]);
});

test("a target clipped by its own horizontal scroll container (carousel) is scrolled within it and clicked", { skip: !chromeAvailable, timeout: 20000 }, async () => {
  const { page, cs, bg } = await setup(`
    <div id="carousel" style="width:100px;height:40px;overflow-x:auto;white-space:nowrap">
      <span style="display:inline-block;width:400px"></span><button id="slide" style="display:inline-block">Slide</button>
    </div>
    <div id="beside" style="position:absolute;top:0;left:100px;width:500px;height:40px">Beside</div>`);
  const found = await cs.invoke({ type: "findElements", query: "slide" });
  const ref = found.result.find((r) => r.role === "button" && r.name === "Slide").ref;
  const r = await bg.handlers.computer({ action: "left_click", ref, tabId: bg.tabId });
  assert.match(r.content[0].text, /^Clicked at \(\d+, \d+\) on button#slide "Slide"/);
  assert.doesNotMatch(r.content[0].text, /Warning/);
  assert.deepEqual(await page.evaluate("clicked"), ["slide"]);
});

test("find flags a scroll-clipped element as off-screen", { skip: !chromeAvailable, timeout: 20000 }, async () => {
  const { bg } = await setup(`
    <div id="container" style="height:100px;overflow:auto">
      <div style="height:400px"></div>
      <button id="target">Target</button>
    </div>`);
  const r = await bg.handlers.find({ query: "Target", tabId: bg.tabId });
  assert.match(r.content[0].text, /\[off-screen, click by ref to scroll it into view\]/);
});

// I5: Node.contains() never crosses a shadow boundary, and a slotted node is not a child of
// the shadow element it renders inside of — so a naive containment check false-positives
// "covered" across any of these shapes. The flat-tree walk (assignedSlot, then a ShadowRoot's
// host) must recognize all three as "inside", not covered.
test("nested (two-level) shadow roots are not reported as covered", { skip: !chromeAvailable, timeout: 20000 }, async () => {
  const { bg, refOf } = await setup(`
    <button id="icon-btn" aria-label="IconBtn" style="width:40px;height:40px">
      <span id="icon-host"></span>
    </button>
    <script>
      const inner = document.createElement("span");
      const innerShadow = inner.attachShadow({ mode: "open" });
      innerShadow.innerHTML = '<svg width="40" height="40"><rect width="40" height="40"/></svg>';
      document.getElementById("icon-host").attachShadow({ mode: "open" }).appendChild(inner);
    </script>`);
  const r = await bg.handlers.computer({ action: "left_click", ref: (await refOf("IconBtn")).ref, tabId: bg.tabId });
  assert.doesNotMatch(r.content[0].text, /Warning/);
});

test("a link wrapping a shadow-DOM card is not reported as covered", { skip: !chromeAvailable, timeout: 20000 }, async () => {
  const { bg, refOf } = await setup(`
    <a id="card-link" href="#" aria-label="CardLink" style="display:block;width:100px;height:40px">
      <span id="card"></span>
    </a>
    <script>document.getElementById("card").attachShadow({mode:"open"}).innerHTML = '<div style="width:100px;height:40px">Card body</div>';</script>`);
  const r = await bg.handlers.computer({ action: "left_click", ref: (await refOf("CardLink")).ref, tabId: bg.tabId });
  assert.doesNotMatch(r.content[0].text, /Warning/);
});

test("a slotted child of a shadow button is not reported as covered", { skip: !chromeAvailable, timeout: 20000 }, async () => {
  const { bg, refOf } = await setup(`
    <div id="host2"></div>
    <script>document.getElementById("host2").attachShadow({mode:"open"}).innerHTML = '<button id="slot-btn" aria-label="SlotBtn" style="width:100px;height:40px"><slot></slot></button>';</script>
    <script>document.getElementById("host2").innerHTML = '<span id="slotted">Click</span>';</script>`);
  const r = await bg.handlers.computer({ action: "left_click", ref: (await refOf("SlotBtn")).ref, tabId: bg.tabId });
  assert.doesNotMatch(r.content[0].text, /Warning/);
});

// M9: hit-testing lands on whatever's actually painted at the point — often a decorative
// inner node (an SVG <rect>) rather than the interactive element it decorates. The reply
// should describe the nearest clickable ancestor, not the raw leaf.
test("the hit describes the nearest interactive ancestor, not raw SVG internals", { skip: !chromeAvailable, timeout: 20000 }, async () => {
  const { bg, refOf } = await setup(`<button id="svg-btn" aria-label="SvgBtn" style="width:40px;height:40px;padding:0;border:0"><svg width="40" height="40"><rect width="40" height="40"/></svg></button>`);
  const r = await bg.handlers.computer({ action: "left_click", ref: (await refOf("SvgBtn")).ref, tabId: bg.tabId });
  assert.match(r.content[0].text, /^Clicked at \(\d+, \d+\) on button#svg-btn "SvgBtn"\.$/);
});

// M6: deciding in/out-of-viewport on the unrounded float center, then rounding only for the
// dispatch, can accept a center like innerHeight - 0.2 as "inside" while the pixel actually
// dispatched to (innerHeight, rounded up) is invalid — find and the click disagreeing about
// the same point. Rounding first makes both agree: find now correctly calls this element
// off-screen, and a ref click still succeeds by scrolling it away from the exact edge.
test("a target whose float center rounds to exactly the viewport edge is scrolled and clicked, and find calls it off-screen", { skip: !chromeAvailable, timeout: 20000 }, async () => {
  const { page, bg, refOf } = await setup(`<button id="edge" style="position:absolute;left:0;top:calc(100vh - 10.7px);height:21px">Edge</button>`);
  const far = await refOf("Edge");
  assert.equal(far.inViewport, false);
  const r = await bg.handlers.computer({ action: "left_click", ref: far.ref, tabId: bg.tabId });
  assert.match(r.content[0].text, /^Clicked at \(\d+, \d+\) on button#edge "Edge" after scrolling it into view/);
  assert.deepEqual(await page.evaluate("clicked"), ["edge"]);
});

// M7: scroll_to must not report success it didn't achieve.
test("scroll_to reports a detached ref instead of a false success", { skip: !chromeAvailable, timeout: 20000 }, async () => {
  const { page, bg, refOf } = await setup(`<button id="gone">Gone</button>`);
  const ref = (await refOf("Gone")).ref;
  // T1: keep a page-side reference so the WeakRef inside content.js survives GC until
  // scroll_to actually runs — otherwise this test can flake, reporting "not found" (ref
  // resolution failed entirely) instead of "no longer exists" (resolved, but disconnected).
  await page.evaluate(`window.__removed = document.getElementById("gone"); window.__removed.remove();`);
  const r = await bg.handlers.computer({ action: "scroll_to", ref, tabId: bg.tabId });
  assert.match(r.content[0].text, /no longer exists/);
});

test("scroll_to reports a hidden ref instead of a false success", { skip: !chromeAvailable, timeout: 20000 }, async () => {
  const { page, bg, refOf } = await setup(`<button id="hidden-btn">Hidden</button>`);
  const ref = (await refOf("Hidden")).ref;
  await page.evaluate(`document.getElementById("hidden-btn").style.display = "none"`);
  const r = await bg.handlers.computer({ action: "scroll_to", ref, tabId: bg.tabId });
  assert.match(r.content[0].text, /has no size \(hidden\?\)/);
});

// M8: at acdbe42, a ref resolved to coordinates for every action, including scroll and
// left_click_drag. Restore that for these two (no click probe/refusal, since neither takes a
// bare "coordinate is the whole point" the way a click does — they just need somewhere to act).
test("scroll accepts a ref, scrolling it into view first", { skip: !chromeAvailable, timeout: 20000 }, async () => {
  const { bg, refOf } = await setup(`<div style="height:3000px"></div><button>Far</button>`);
  const ref = (await refOf("Far")).ref;
  const r = await bg.handlers.computer({ action: "scroll", ref, scroll_direction: "down", tabId: bg.tabId });
  assert.match(r.content[0].text, /^Scrolled down by \d+ ticks at \(\d+, \d+\)/);
});

// M10: tests the review found missing.
test("a label with no associated control carries a warning", { skip: !chromeAvailable, timeout: 20000 }, async () => {
  const { bg, refOf } = await setup(`<label id="l2" style="display:block;width:200px">Orphan</label>`);
  const r = await bg.handlers.computer({ action: "left_click", ref: (await refOf("Orphan")).ref, tabId: bg.tabId });
  assert.match(r.content[0].text, /This label has no associated control, so the click may do nothing\./);
});

test("scroll_to with a coordinate scrolls the page and reports where", { skip: !chromeAvailable, timeout: 20000 }, async () => {
  const { page, bg } = await setup(`<div style="height:3000px"></div>`);
  const r = await bg.handlers.computer({ action: "scroll_to", coordinate: [0, 500], tabId: bg.tabId });
  assert.equal(r.content[0].text, "Scrolled the page to (0, 500).");
  assert.ok((await page.evaluate("scrollY")) > 0);
});

test("double_click reports what it hit", { skip: !chromeAvailable, timeout: 20000 }, async () => {
  const { bg } = await setup(`<button id="d" style="position:absolute;top:0;left:0;width:100px;height:40px">Double</button>`);
  const r = await bg.handlers.computer({ action: "double_click", coordinate: [50, 20], tabId: bg.tabId });
  assert.match(r.content[0].text, /^Double-clicked at \(50, 20\) on button#d "Double"/);
});

test("a coordinate click on a label with a disabled control carries a warning", { skip: !chromeAvailable, timeout: 20000 }, async () => {
  const { bg } = await setup(`<label id="l3" for="c3" style="position:absolute;top:0;left:0;display:block;width:200px;height:20px">Accept</label><input id="c3" type="checkbox" disabled>`);
  const r = await bg.handlers.computer({ action: "left_click", coordinate: [50, 10], tabId: bg.tabId });
  assert.match(r.content[0].text, /This label's control is disabled\./);
});

// N1: clippedByAncestor must walk the containing-block chain, not the plain DOM ancestor
// chain — html/body's own overflow applies to the viewport (already checked separately), a
// position:fixed element's only clip is the viewport, and an absolutely positioned box's
// containing block is its nearest non-static ancestor, so it escapes any unpositioned
// overflow:hidden wrapper in between.
test("find does not flag a fixed element off-screen due to html's own overflow", { skip: !chromeAvailable, timeout: 20000 }, async () => {
  const { bg } = await setup(`<style>html{overflow-x:hidden}</style><button id="cookie" style="position:fixed;bottom:0;left:0">Accept</button>`);
  const r = await bg.handlers.find({ query: "Accept", tabId: bg.tabId });
  assert.doesNotMatch(r.content[0].text, /off-screen/);
});

test("find does not flag a fixed element off-screen due to body's own overflow", { skip: !chromeAvailable, timeout: 20000 }, async () => {
  const { bg } = await setup(`<style>body{overflow:hidden}</style><button id="modal-btn" style="position:fixed;top:10px;left:10px">Close</button>`);
  const r = await bg.handlers.find({ query: "Close", tabId: bg.tabId });
  assert.doesNotMatch(r.content[0].text, /off-screen/);
});

test("find does not flag a fixed popover off-screen due to a small wrapping overflow:hidden box", { skip: !chromeAvailable, timeout: 20000 }, async () => {
  const { bg } = await setup(`<div style="height:50px;overflow:hidden"><button id="popover" style="position:fixed;top:200px;left:10px">Popover</button></div>`);
  const r = await bg.handlers.find({ query: "Popover", tabId: bg.tabId });
  assert.doesNotMatch(r.content[0].text, /off-screen/);
});

test("find does not flag an absolutely positioned item off-screen when it escapes an unpositioned overflow:hidden wrapper", { skip: !chromeAvailable, timeout: 20000 }, async () => {
  const { bg } = await setup(`
    <div style="position:relative">
      <div style="overflow:hidden;height:20px">
        <button id="menu-item" style="position:absolute;top:100px;left:10px">Menu item</button>
      </div>
    </div>`);
  const r = await bg.handlers.find({ query: "Menu item", tabId: bg.tabId });
  assert.doesNotMatch(r.content[0].text, /off-screen/);
});

// N2: don't scroll a target through its own label — the click already reaches the (possibly
// visually hidden) control via the label, and don't claim a scroll happened when nothing moved.
test("a visually-hidden checkbox behind its own label is clicked without scrolling or a false cover warning", { skip: !chromeAvailable, timeout: 20000 }, async () => {
  const { page, cs, bg } = await setup(`
    <input id="cb" type="checkbox" style="position:absolute;clip-path:inset(50%);top:10px;left:10px">
    <label for="cb" style="position:absolute;top:10px;left:10px;width:20px;height:20px;display:block;background:#ccc"></label>
    <div style="height:3000px"></div>`);
  const found = await cs.invoke({ type: "findElements", query: "checkbox" });
  const ref = found.result.find((r) => r.role === "checkbox").ref;
  const r = await bg.handlers.computer({ action: "left_click", ref, tabId: bg.tabId });
  assert.doesNotMatch(r.content[0].text, /after scrolling/);
  assert.doesNotMatch(r.content[0].text, /Warning/);
  assert.equal(await page.evaluate("scrollY"), 0);
  assert.equal(await page.evaluate("document.getElementById('cb').checked"), true);
});

// N3: getRefTarget scrolls an off-screen drop target into view, which invalidates
// start_coordinate (taken from the pre-scroll screenshot) — the drag must refuse instead of
// dragging from a now-stale position.
test("left_click_drag refuses a ref that had to scroll instead of dragging from a stale position", { skip: !chromeAvailable, timeout: 20000 }, async () => {
  const { bg, refOf } = await setup(`<div style="height:3000px"></div><button id="drop">Drop</button>`);
  const ref = (await refOf("Drop")).ref;
  const r = await bg.handlers.computer({ action: "left_click_drag", start_coordinate: [10, 10], ref, tabId: bg.tabId });
  assert.equal(r.content[0].text, `Scrolled ${ref} into view, so start_coordinate is stale. Take a new screenshot and retry the drag.`);
  assert.equal(bg.calls.filter((c) => c[1] === "Input.dispatchMouseEvent").length, 0);
});

test("left_click_drag to an in-view ref still drags normally", { skip: !chromeAvailable, timeout: 20000 }, async () => {
  const { bg, refOf } = await setup(`<button id="drop" style="position:absolute;top:10px;left:200px">Drop</button>`);
  const ref = (await refOf("Drop")).ref;
  const r = await bg.handlers.computer({ action: "left_click_drag", start_coordinate: [10, 10], ref, tabId: bg.tabId });
  assert.match(r.content[0].text, /^Dragged from \(10, 10\) to \(\d+, \d+\)/);
});
