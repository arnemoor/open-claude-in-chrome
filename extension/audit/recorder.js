// Records a masked DOM replay of the page via rrweb, batches the events, and relays
// them to the background service worker. Classic script, injected into the ISOLATED
// world alongside vendor/rrweb-record.min.js by ensureRecorder() (audit.js).
//
// Idempotent per document: evaluating this file a second time in the same world (a
// repeat injection) is a no-op, so a page never ends up with two recorders emitting
// duplicate events.

(() => {
  const KEY = Symbol.for("ocic.audit.recorder");
  if (globalThis[KEY]) return;
  globalThis[KEY] = true;

  const FLUSH_MS = 1000;
  const FLUSH_COUNT = 100;

  let buffer = [];
  let timer = null;

  function flush() {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (buffer.length === 0) return;
    const events = buffer;
    buffer = [];
    try {
      chrome.runtime.sendMessage({ type: "ocic_audit_events", events });
    } catch {
      // Extension context can be gone (page torn down, extension reloaded); drop.
    }
  }

  function onEmit(event) {
    buffer.push(event);
    if (buffer.length >= FLUSH_COUNT) flush();
    else if (timer === null) timer = setTimeout(flush, FLUSH_MS);
  }

  globalThis.rrwebRecord.record({
    emit: onEmit,
    maskAllInputs: true,
    maskInputOptions: { password: true },
    // maskAllInputs covers form controls only. Contenteditable regions (rich-text
    // editors, chat boxes) hold typed text as DOM text, so mask them too. The selector
    // matches the host element: rrweb checks the element itself and, for mutations,
    // every ancestor via closest(), so nested text and text typed straight into an
    // empty host are both covered.
    maskTextSelector: '[contenteditable]:not([contenteditable="false"])',
    recordCanvas: false,
    collectFonts: false,
    inlineImages: false,
    sampling: { mousemove: 100, scroll: 150, input: "last" },
  });

  window.addEventListener("pagehide", flush);
})();
