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
    // maskAllInputs only covers <input>/<textarea>/<select>; contenteditable regions
    // (rich-text editors, some chat/comment boxes) hold their text as plain DOM text
    // nodes, so they need maskTextSelector instead. This matches the contenteditable
    // host element itself, not a "... *" descendant selector: rrweb resolves
    // maskTextSelector with el.matches() against the element itself (or a text node's
    // immediate parent) the first time a branch's mask state is decided, and with
    // el.closest() (which walks up through every ancestor) for every incremental
    // mutation — both a brand-new text node (genAdds) and a changed one
    // (characterData) always re-check with closest(), regardless of nesting depth. A
    // "... *" variant would miss text that is a direct child of the contenteditable
    // element itself (the common case: typing into a freshly focused, empty div),
    // since closest()/matches() on that div would then need an ancestor of the div to
    // match, not the div itself.
    maskTextSelector: '[contenteditable]:not([contenteditable="false"])',
    recordCanvas: false,
    collectFonts: false,
    inlineImages: false,
    sampling: { mousemove: 100, scroll: 150, input: "last" },
  });

  window.addEventListener("pagehide", flush);
})();
