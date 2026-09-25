// form_input, file_upload and upload_image on a hostile page: a <form> whose control is named like
// a DOM property (tagName, querySelector, scrollIntoView, shadowRoot, ...) replaces that property
// on the form, so the form paths read everything through content.js's captured dom helpers. A
// reply claims success only when the value really landed.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { loadBackground } from "./harness/fake-chrome.mjs";
import { chromeAvailable, launchChrome, openPage, injectContentScript } from "./harness/browser.mjs";

const CONTENT = path.join(import.meta.dirname, "..", "extension", "content.js");
const CLOBBER_NAMES = ["tagName", "querySelector", "querySelectorAll", "scrollIntoView", "shadowRoot", "dispatchEvent", "value", "type", "contentEditable", "textContent"];

let browser;
before(async () => {
  if (!chromeAvailable) return;
  browser = await launchChrome();
  await browser.send("Browser.setDownloadBehavior", { behavior: "deny" });
}, { timeout: 30000 });
after(async () => { await browser?.close(); });

async function setup(html) {
  const page = await openPage(browser, { html });
  const cs = await injectContentScript(page, CONTENT);
  return { page, cs };
}

async function refOf(cs, pattern) {
  const tree = (await cs.invoke({ type: "generateAccessibilityTree", options: {} })).result;
  const m = tree.match(pattern);
  assert.ok(m, `no ref for ${pattern} in:\n${tree}`);
  return m[1];
}

for (const name of CLOBBER_NAMES) {
  test(`real Chrome: form_input on a form ref sets the input even when a control is named ${name}`, { skip: !chromeAvailable, timeout: 20000 }, async () => {
    const { page, cs } = await setup(`<form aria-label="F"><input name="${name}" id="t"></form>`);
    const ref = await refOf(cs, /form "F" \[(ref_\d+)\]/);
    const reply = await cs.invoke({ type: "setFormValue", ref, value: "hello" });
    assert.deepEqual({ ...reply.result }, { success: true, value: "hello" });
    assert.equal(await page.evaluate("document.getElementById('t').value"), "hello");
  });

  test(`real Chrome: file_upload and upload_image find the file input in a form with a control named ${name}`, { skip: !chromeAvailable, timeout: 20000 }, async () => {
    const { page, cs } = await setup(`<form aria-label="F"><input type="file" name="${name}" id="f"></form>`);
    const ref = await refOf(cs, /form "F" \[(ref_\d+)\]/);
    const mark = await cs.invoke({ type: "markFileInput", ref });
    assert.match(mark.result.token, /^mcp_/, JSON.stringify(mark.result));
    assert.equal(await page.evaluate("document.getElementById('f').getAttribute('data-mcp-file-input')"), mark.result.token);
    await cs.invoke({ type: "unmarkFileInput", ref });
    assert.equal(await page.evaluate("document.getElementById('f').hasAttribute('data-mcp-file-input')"), false);
    const upload = await cs.invoke({ type: "uploadImage", ref, base64: "AAAA", filename: "shot.jpg", mimeType: "image/jpeg" });
    assert.equal(upload.result.success, true, JSON.stringify(upload.result));
    assert.equal(await page.evaluate("document.getElementById('f').files.length"), 1);
  });
}

// Nothing to set: the old fallback assigned an expando "value" to the element and reported it back
// as a success while the page showed nothing.
test("real Chrome: form_input on an element with nothing to set replies with an error, through the handler with isError", { skip: !chromeAvailable, timeout: 20000 }, async () => {
  const { page, cs } = await setup(`<form aria-label="F"><button type="button">Go</button></form><div role="group" aria-label="Box"><span>x</span></div>`);
  for (const pattern of [/form "F" \[(ref_\d+)\]/, /group "Box" \[(ref_\d+)\]/]) {
    const ref = await refOf(cs, pattern);
    const reply = await cs.invoke({ type: "setFormValue", ref, value: "hello" });
    assert.match(reply.result.error || "", /^Cannot set a value on <(form|div)>/, JSON.stringify(reply.result));
  }
  const bg = await loadBackground({ page, content: cs });
  const ref = await refOf(cs, /group "Box" \[(ref_\d+)\]/);
  const r = await bg.handlers.form_input({ ref, value: "hello", tabId: bg.tabId });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /^Error: Cannot set a value on <div>/);
});

test("real Chrome: form_input on a select with no matching option replies with an error and keeps the selection", { skip: !chromeAvailable, timeout: 20000 }, async () => {
  const { page, cs } = await setup(`<select aria-label="S" id="s"><option value="a">Alpha</option><option value="b" selected>Beta</option></select>`);
  const ref = await refOf(cs, /combobox "S" \[(ref_\d+)\]/);
  const reply = await cs.invoke({ type: "setFormValue", ref, value: "zzz" });
  assert.match(reply.result.error || "", /zzz/, JSON.stringify(reply.result));
  assert.equal(await page.evaluate("document.getElementById('s').value"), "b");
  const byText = await cs.invoke({ type: "setFormValue", ref, value: "Alpha" });
  assert.deepEqual({ ...byText.result }, { success: true, value: "a" });
});

test("real Chrome: form_input sets a contenteditable element and one inside an editing host", { skip: !chromeAvailable, timeout: 20000 }, async () => {
  const { page, cs } = await setup(`<div contenteditable="true" aria-label="Editor" id="e"></div><div contenteditable="true"><h2 id="h">Title</h2></div>`);
  const editor = await refOf(cs, /"Editor" \[(ref_\d+)\]/);
  assert.deepEqual({ ...(await cs.invoke({ type: "setFormValue", ref: editor, value: "typed" })).result }, { success: true, value: "typed" });
  assert.equal(await page.evaluate("document.getElementById('e').textContent"), "typed");
  const heading = await refOf(cs, /heading "Title" \[(ref_\d+)\]/);
  assert.deepEqual({ ...(await cs.invoke({ type: "setFormValue", ref: heading, value: "New" })).result }, { success: true, value: "New" });
  assert.equal(await page.evaluate("document.getElementById('h').textContent"), "New");
});

// The page logs every input and change event, so a test can check which ones a call fired.
const EVENT_LOG = `<script>window.formEvents = []; for (const type of ["input", "change"]) document.addEventListener(type, (e) => window.formEvents.push(e.target.id + ":" + type), true);</script>`;
const takeEvents = (page) => page.evaluate("window.formEvents.splice(0)");

// A change that did not take is an error too: a checkbox or radio that does not end at the requested
// state, or a value the field's sanitization turned into nothing. A value the field only normalizes
// (color case, range clamping) is kept, so that stays a success with the actual value.
test("real Chrome: form_input reports a checkbox or radio that did not end at the requested state", { skip: !chromeAvailable, timeout: 20000 }, async () => {
  const { page, cs } = await setup(`${EVENT_LOG}<input type="radio" name="r" aria-label="First" id="r1" checked><input type="radio" name="r" aria-label="Second" id="r2">
    <input type="checkbox" aria-label="Blocked" id="blocked" onclick="return false"><input type="checkbox" aria-label="Plain" id="plain">`);
  const set = async (label, role, value) => (await cs.invoke({ type: "setFormValue", ref: await refOf(cs, new RegExp(`${role} "${label}" \\[(ref_\\d+)\\]`)), value })).result;
  const checked = (id) => page.evaluate(`document.getElementById(${JSON.stringify(id)}).checked`);

  assert.match((await set("First", "radio", false)).error || "", /radio button/);
  assert.equal(await checked("r1"), true);
  assert.deepEqual(await takeEvents(page), [], "no input or change event for a radio that did not change");
  assert.match((await set("Blocked", "checkbox", true)).error || "", /still unchecked/);
  assert.equal(await checked("blocked"), false);
  assert.deepEqual(await takeEvents(page), [], "no input or change event for a blocked checkbox");

  assert.deepEqual({ ...(await set("Plain", "checkbox", true)) }, { success: true, checked: true });
  assert.deepEqual(await takeEvents(page), ["plain:input", "plain:change"]);
  assert.deepEqual({ ...(await set("Second", "radio", "true")) }, { success: true, checked: true });
  assert.deepEqual(await takeEvents(page), ["r2:input", "r2:change"]);
  assert.equal(await checked("r1"), false);

  const bg = await loadBackground({ page, content: cs });
  const r = await bg.handlers.form_input({ ref: await refOf(cs, /checkbox "Blocked" \[(ref_\d+)\]/), value: true, tabId: bg.tabId });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /^Error: .*still unchecked/);
});

test("real Chrome: form_input reports a value the field rejected and keeps the old one, but keeps a normalized value", { skip: !chromeAvailable, timeout: 20000 }, async () => {
  const { page, cs } = await setup(`${EVENT_LOG}<input type="date" aria-label="Day" id="day" value="2024-01-02"><input type="number" aria-label="Count" id="count" value="5">
    <input type="color" aria-label="Color" id="color"><input type="range" aria-label="Level" id="level" min="0" max="100">`);
  const set = async (label, role, value) => (await cs.invoke({ type: "setFormValue", ref: await refOf(cs, new RegExp(`${role} "${label}" \\[(ref_\\d+)\\]`)), value })).result;
  const valueOf = (id) => page.evaluate(`document.getElementById(${JSON.stringify(id)}).value`);

  assert.match((await set("Day", "textbox", "not-a-date")).error || "", /did not accept the value/);
  assert.equal(await valueOf("day"), "2024-01-02");
  assert.match((await set("Count", "spinbutton", "abc")).error || "", /did not accept the value/);
  assert.equal(await valueOf("count"), "5");
  assert.deepEqual(await takeEvents(page), [], "no input or change event for a rejected value");

  assert.deepEqual({ ...(await set("Day", "textbox", "2024-05-06")) }, { success: true, value: "2024-05-06" });
  assert.deepEqual(await takeEvents(page), ["day:input", "day:change"]);
  assert.deepEqual({ ...(await set("Color", "textbox", "#FF0000")) }, { success: true, value: "#ff0000" });
  assert.deepEqual(await takeEvents(page), ["color:input", "color:change"]);
  assert.deepEqual({ ...(await set("Level", "slider", "150")) }, { success: true, value: "100" });
  assert.deepEqual(await takeEvents(page), ["level:input", "level:change"]);
  assert.deepEqual({ ...(await set("Count", "spinbutton", "")) }, { success: true, value: "" });
  assert.deepEqual(await takeEvents(page), ["count:input", "count:change"]);

  const bg = await loadBackground({ page, content: cs });
  const r = await bg.handlers.form_input({ ref: await refOf(cs, /textbox "Day" \[(ref_\d+)\]/), value: "not-a-date", tabId: bg.tabId });
  assert.equal(r.isError, true);
});
