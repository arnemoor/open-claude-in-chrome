import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { loadBackground } from "./harness/fake-chrome.mjs";
import { chromeAvailable, launchChrome, openPage, navigate } from "./harness/browser.mjs";

test("a redirect shows each hop with its own status", async () => {
  const bg = await loadBackground();
  const fire = (m, p) => bg.chrome.debugger.onEvent.fire({ tabId: bg.tabId }, m, p);
  fire("Network.requestWillBeSent", { requestId: "R1", type: "Document", request: { url: "http://a.test/", method: "GET" } });
  fire("Network.requestWillBeSent", { requestId: "R1", type: "Document", request: { url: "https://a.test/", method: "GET" }, redirectResponse: { status: 301, statusText: "Moved", mimeType: "text/html" } });
  fire("Network.responseReceived", { requestId: "R1", type: "Document", response: { url: "https://a.test/", status: 200, statusText: "OK", mimeType: "text/html" } });
  const r = await bg.handlers.read_network_requests({ tabId: bg.tabId });
  assert.equal(r.content[0].text, "Network requests (2):\nGET http://a.test/ → 301 [text/html]\nGET https://a.test/ → 200 [text/html]");
});

test("real Chrome: a server-side redirect is logged hop by hop", { skip: !chromeAvailable, timeout: 20000 }, async () => {
  const server = http.createServer((req, res) => {
    if (req.url === "/r") { res.writeHead(302, { Location: "/final" }); res.end(); }
    else { res.writeHead(200, { "Content-Type": "text/html" }); res.end("<p>final</p>"); }
  }).listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await launchChrome();
  try {
    const page = await openPage(browser);
    const bg = await loadBackground({ page });
    await bg.handlers.read_network_requests({ tabId: bg.tabId });
    await navigate(page, `${base}/r`);
    const text = (await bg.handlers.read_network_requests({ tabId: bg.tabId, urlPattern: base })).content[0].text;
    assert.match(text, new RegExp(`GET ${base}/r → 302`));
    assert.match(text, new RegExp(`GET ${base}/final → 200`));
    assert.doesNotMatch(text, new RegExp(`${base}/(r|final) \\(pending\\)`)); // the favicon may still be in flight
  } finally {
    await browser.close();
    server.close();
  }
});
