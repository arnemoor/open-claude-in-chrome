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
      // The returned promise can also reject after the call is made (the
      // channel closing mid-flight, e.g. on a back/forward-cache entry, or the
      // batch exceeding Chrome's message size limit) — both must be swallowed,
      // or the rejection surfaces as an uncaught error in the page's console.
      chrome.runtime.sendMessage({ type: "ocic_audit_events", events }).catch(() => {});
    } catch {
      // Extension context can already be gone (page torn down, extension
      // reloaded) before the call is even made.
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
    // I1: maskAllInputs only overwrites `value` with the masked live value when
    // that value is non-empty, so a hidden input's raw HTML value attribute
    // (a CSRF token, one set by a script, one present in markup) would
    // otherwise go out unmasked. Blocking it drops its attributes down to
    // class/rr_width/rr_height and skips attribute mutations on it entirely.
    // A worker-side walker (redact.js's redactEvents, run from
    // Audit.onRecorderEvents) additionally masks any input/textarea value that
    // reaches the wire regardless — e.g. a prefilled password cleared by script
    // before the recorder started, which blockSelector alone doesn't touch,
    // since its own field type isn't hidden.
    blockSelector: "input[type=hidden]",
    recordCanvas: false,
    collectFonts: false,
    inlineImages: false,
    sampling: { mousemove: 100, scroll: 150, input: "last" },
  });

  // M5: mark this document as "has a recorder" only after record() actually
  // succeeded. Setting it first (as an earlier version of this file did) would
  // let a transient failure here (rrwebRecord missing, an internal rrweb
  // error) permanently poison ensureRecorder's presence probe into believing a
  // working recorder is already there, with no retry for the rest of the
  // document's life. If record() throws, this line — and the listeners below —
  // are simply never reached, which is what leaves the key unset.
  globalThis[KEY] = true;

  window.addEventListener("pagehide", flush);
  // M3: a back/forward-cache restore resumes this exact recorder instance (the
  // page's JS state, including this closure, survives bfcache) with no new
  // full snapshot on its own, so the stored stream would otherwise jump
  // straight from an earlier page's snapshot to this one's increments, with no
  // base for the replayer to apply them onto.
  window.addEventListener("pageshow", (event) => {
    if (event.persisted) globalThis.rrwebRecord.record.takeFullSnapshot();
  });
})();
