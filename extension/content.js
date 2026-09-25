// Content script for Open Claude in Chrome extension.
// Injected into every page. Provides:
// - Accessibility tree generation (read_page)
// - Element ref mapping with WeakRef (persistent across calls)
// - Form input handling
// - Page text extraction
// - Element finding by text/attributes

(function () {
  if (window.__unblockedChromeLoaded === true) return;
  window.__unblockedChromeLoaded = true;

  // --- DOM helpers, immune to clobbering by page markup ---
  // <form> elements and `document` have [LegacyOverrideBuiltIns]: a descendant control named like a
  // built-in property (e.g. <input name="title">) replaces that property on the form, and a top-level
  // <img name="body"> replaces document.body. Every read below goes through the true prototype
  // getter/method instead of the (possibly clobbered) instance property.
  const tagNameGet = Object.getOwnPropertyDescriptor(Element.prototype, "tagName").get;
  const childrenGet = Object.getOwnPropertyDescriptor(Element.prototype, "children").get;
  const shadowRootGet = Object.getOwnPropertyDescriptor(Element.prototype, "shadowRoot").get;
  const textContentGet = Object.getOwnPropertyDescriptor(Node.prototype, "textContent").get;
  const nodeTypeGet = Object.getOwnPropertyDescriptor(Node.prototype, "nodeType").get;
  const offsetParentGet = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetParent").get;
  const docTitleGet = Object.getOwnPropertyDescriptor(Document.prototype, "title").get;
  const docBodyGet = Object.getOwnPropertyDescriptor(Document.prototype, "body").get;
  const docDocumentElementGet = Object.getOwnPropertyDescriptor(Document.prototype, "documentElement").get;
  const getAttributeFn = Element.prototype.getAttribute;
  const closestFn = Element.prototype.closest;
  const matchesFn = Element.prototype.matches;
  const rectFn = Element.prototype.getBoundingClientRect;
  const docQueryFn = Document.prototype.querySelector;
  const docByIdFn = Document.prototype.getElementById;
  const docElementFromPointFn = Document.prototype.elementFromPoint;
  const scrollIntoViewFn = Element.prototype.scrollIntoView;
  const elementQueryFn = Element.prototype.querySelector;
  const querySelectorAllFn = Element.prototype.querySelectorAll;
  const fragmentQueryFn = DocumentFragment.prototype.querySelector;
  const fragmentQueryAllFn = DocumentFragment.prototype.querySelectorAll;
  const parentNodeGet = Object.getOwnPropertyDescriptor(Node.prototype, "parentNode").get;
  const isConnectedGet = Object.getOwnPropertyDescriptor(Node.prototype, "isConnected").get;
  const assignedSlotGet = Object.getOwnPropertyDescriptor(Element.prototype, "assignedSlot").get;
  // Tag-owned getter (HTMLLabelElement only): called only on what enclosingLabel returns, which
  // is already instanceof-guarded there (the same rule as offsetParentGet above), so it's not
  // part of the dom object. Two call sites: labelNotes and isOwnLabel.
  const labelControlGet = Object.getOwnPropertyDescriptor(HTMLLabelElement.prototype, "control").get;
  // Not part of the public dom object: captured the same way, called directly at its one call
  // site (in getPageText).
  const cloneNodeFn = Node.prototype.cloneNode;
  // The same, for setFormValue, whose target can be the ref'd element itself: a <form> there
  // has these replaced by a control named like them. isContentEditableGet is HTMLElement-owned,
  // so it is called only after an instanceof HTMLElement check.
  const isContentEditableGet = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "isContentEditable").get;
  const textContentSet = Object.getOwnPropertyDescriptor(Node.prototype, "textContent").set;
  const dispatchEventFn = EventTarget.prototype.dispatchEvent;

  function str(value) {
    return typeof value === "string" ? value : "";
  }

  // True when this page is one the agent is never allowed to act on: a local file, or this
  // extension's own page. background.js's tabAccessError already checks the tab's URL before
  // dispatching a message here, but the page can navigate in the gap between that check and
  // this handler actually running (e.g. a timed history.back()) — this re-checks against the
  // page's own live location as a backstop.
  function isBlockedPage() {
    return location.protocol === "file:" || location.origin === `chrome-extension://${chrome.runtime.id}`;
  }
  const BLOCKED_PAGE_TEXT = "This tab shows a local file or this extension's own page, which the agent cannot use.";

  const dom = {
    tag: (el) => (el ? str(tagNameGet.call(el)).toLowerCase() : ""),
    // Raw getAttribute result (string or null) — a native call, so it is always one of those two
    // types regardless of clobbering. Callers that need a guaranteed string use dom.str(...).
    attr: (el, name) => (el ? getAttributeFn.call(el, name) : null),
    children: (el) => (el ? childrenGet.call(el) : []),
    text: (el) => (el ? str(textContentGet.call(el)) : ""),
    nodeType: (el) => (el ? nodeTypeGet.call(el) : 0),
    shadowRoot: (el) => (el ? shadowRootGet.call(el) : null),
    closest: (el, sel) => (el ? closestFn.call(el, sel) : null),
    matches: (el, sel) => (el ? matchesFn.call(el, sel) : false),
    rect: (el) => (el ? rectFn.call(el) : null),
    parentNode: (n) => (n ? parentNodeGet.call(n) : null),
    isConnected: (n) => (n ? isConnectedGet.call(n) : false),
    scrollIntoView: (el, opts) => { if (el) scrollIntoViewFn.call(el, opts); },
    // root is an Element or a ShadowRoot (a DocumentFragment), each queried through the method
    // its own prototype owns.
    query: (root, sel) => (root instanceof Element ? elementQueryFn : fragmentQueryFn).call(root, sel),
    queryAll: (root, sel) => (root instanceof Element ? querySelectorAllFn : fragmentQueryAllFn).call(root, sel),
    str,
    docTitle: () => str(docTitleGet.call(document)),
    docBody: () => docBodyGet.call(document),
    docDocumentElement: () => docDocumentElementGet.call(document),
    docQuery: (sel) => docQueryFn.call(document, sel),
    docById: (id) => docByIdFn.call(document, id),
    docElementFromPoint: (x, y) => docElementFromPointFn.call(document, x, y),
  };

  // --- Element reference map ---
  // Persistent ref IDs stored as WeakRefs so GC still works
  let refCounter = 0;
  const elementMap = {}; // refId -> WeakRef<Element>
  const reverseMap = new WeakMap(); // Element -> refId

  function getOrAssignRef(el) {
    const existing = reverseMap.get(el);
    if (existing && elementMap[existing]?.deref() === el) return existing;
    const ref = `ref_${++refCounter}`;
    elementMap[ref] = new WeakRef(el);
    reverseMap.set(el, ref);
    return ref;
  }

  function resolveRef(refId) {
    const wr = elementMap[refId];
    if (!wr) return null;
    const el = wr.deref();
    if (!el) {
      delete elementMap[refId];
      return null;
    }
    return el;
  }

  // --- ARIA role mapping ---
  const TAG_TO_ROLE = {
    a: "link",
    button: "button",
    input: "textbox",
    textarea: "textbox",
    select: "combobox",
    img: "img",
    h1: "heading",
    h2: "heading",
    h3: "heading",
    h4: "heading",
    h5: "heading",
    h6: "heading",
    nav: "navigation",
    main: "main",
    header: "banner",
    footer: "contentinfo",
    aside: "complementary",
    form: "form",
    table: "table",
    tr: "row",
    th: "columnheader",
    td: "cell",
    ul: "list",
    ol: "list",
    li: "listitem",
    dialog: "dialog",
    details: "group",
    summary: "button",
    progress: "progressbar",
    meter: "meter",
    video: "video",
    audio: "audio",
    section: "region",
    article: "article",
  };

  function getRole(el) {
    const explicitRole = dom.attr(el, "role");
    if (explicitRole) return explicitRole;
    const tag = dom.tag(el);
    if (tag === "input") {
      const type = (el.type || "text").toLowerCase();
      const typeRoles = {
        checkbox: "checkbox",
        radio: "radio",
        range: "slider",
        button: "button",
        submit: "button",
        reset: "button",
        search: "searchbox",
        number: "spinbutton",
      };
      return typeRoles[type] || "textbox";
    }
    return TAG_TO_ROLE[tag] || null;
  }

  // --- Accessible name ---
  function getAccessibleName(el) {
    // Priority: aria-label > aria-labelledby > placeholder > title > alt > label > text
    const ariaLabel = dom.attr(el, "aria-label");
    if (ariaLabel) return ariaLabel.trim();

    const labelledBy = dom.attr(el, "aria-labelledby");
    if (labelledBy) {
      const names = labelledBy
        .split(/\s+/)
        .map((id) => dom.text(dom.docById(id)).trim())
        .filter(Boolean);
      if (names.length) return names.join(" ");
    }

    const placeholder = dom.attr(el, "placeholder");
    if (placeholder) return placeholder.trim();
    const title = dom.attr(el, "title");
    if (title) return title.trim();
    const alt = dom.attr(el, "alt");
    if (alt) return alt.trim();

    // Associated <label>
    const id = dom.attr(el, "id");
    if (id) {
      const label = dom.docQuery(`label[for="${CSS.escape(id)}"]`);
      if (label) return dom.text(label).trim();
    }
    const labelAncestor = dom.closest(el, "label");
    if (labelAncestor) {
      const labelText = dom.text(labelAncestor).trim();
      if (labelText) return labelText;
    }

    // Direct text content (only for leaf-ish elements)
    const tag = dom.tag(el);
    if (["a", "button", "h1", "h2", "h3", "h4", "h5", "h6", "li", "summary", "label", "th", "td", "span"].includes(tag)) {
      const text = dom.text(el).trim();
      if (text && text.length < 200) return text;
    }

    return "";
  }

  // --- Interactivity check ---
  function isInteractive(el) {
    const tag = dom.tag(el);
    if (["a", "button", "input", "textarea", "select", "summary", "details"].includes(tag)) return true;
    const role = dom.attr(el, "role");
    if (role && ["button", "link", "textbox", "checkbox", "radio", "tab", "menuitem", "switch", "combobox", "slider", "spinbutton", "searchbox", "option"].includes(role)) return true;
    if (typeof el.tabIndex === "number" && el.tabIndex >= 0) return true;
    if (typeof el.onclick === "function" || dom.attr(el, "onclick")) return true;
    // Presence-based, case-insensitive: a bare `contenteditable` or `contenteditable="TRUE"` both count.
    if (dom.matches(el, '[contenteditable=""], [contenteditable="true" i]')) return true;
    return false;
  }

  // --- Visibility check ---
  function isVisible(el) {
    // offsetParent is an HTMLElement.prototype getter: calling it on an SVGElement/MathMLElement
    // throws (illegal invocation). Those elements just never trigger this check, as before.
    const hiddenByOffset = el instanceof HTMLElement && offsetParentGet.call(el) === null;
    if (hiddenByOffset && dom.tag(el) !== "body" && getComputedStyle(el).position !== "fixed") return false;
    const style = getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") return false;
    return true;
  }

  // --- Accessibility tree generation ---
  function generateAccessibilityTree(options = {}) {
    const filter = options.filter || "all";
    const maxDepth = options.depth || 15;
    const maxChars = options.max_chars || 50000;
    const startRefId = options.ref_id || null;

    let output = "";
    let charCount = 0;
    let truncated = false;

    function append(text) {
      if (truncated) return false;
      if (charCount + text.length > maxChars) {
        output += text.substring(0, maxChars - charCount);
        output += "\n... (truncated)";
        truncated = true;
        return false;
      }
      output += text;
      charCount += text.length;
      return true;
    }

    function walk(el, depth, indent) {
      if (truncated) return;
      if (depth > maxDepth) return;
      if (!el || dom.nodeType(el) !== 1) return;

      const tag = dom.tag(el);
      // Skip invisible, script, style, svg internals
      if (["script", "style", "noscript", "template"].includes(tag)) return;

      const role = getRole(el);
      const name = getAccessibleName(el);
      const interactive = isInteractive(el);
      const visible = isVisible(el);

      // Filter: if interactive-only mode, skip non-interactive non-container elements
      const isContainer = dom.children(el).length > 0;
      if (filter === "interactive" && !interactive && !isContainer) return;

      const shouldShow =
        (filter === "all" && (role || name)) ||
        (filter === "interactive" && interactive);

      if (shouldShow && visible) {
        const ref = getOrAssignRef(el);
        let line = `${indent}`;

        if (role) line += `${role}`;
        if (name) line += ` "${name.substring(0, 100)}"`;
        line += ` [${ref}]`;

        // Extra info for specific elements. Tag-name equality alone isn't enough: an element inside
        // <svg>/<math> foreign content can share an HTML tag name (e.g. a "select") without being the
        // HTML interface that owns these properties, so each read is also guarded by instanceof.
        if (tag === "a" && el instanceof HTMLAnchorElement && el.href) line += ` href="${el.href}"`;
        if (tag === "img" && el instanceof HTMLImageElement && el.src) line += ` src="${el.src.substring(0, 100)}"`;
        if (["input", "textarea"].includes(tag) && (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) && el.value) line += ` value="${el.value.substring(0, 100)}"`;
        if (tag === "input" && el instanceof HTMLInputElement) line += ` type="${el.type || "text"}"`;
        const expanded = dom.attr(el, "aria-expanded");
        if (expanded) line += ` expanded=${expanded}`;
        const checked = dom.attr(el, "aria-checked");
        if (checked) line += ` checked=${checked}`;
        const selected = dom.attr(el, "aria-selected");
        if (selected) line += ` selected=${selected}`;
        if (dom.matches(el, ":disabled")) line += " disabled";

        // Select options
        if (tag === "select" && el instanceof HTMLSelectElement) {
          const opts = Array.from(el.options).map(
            (o) => `${o.selected ? "*" : " "}${o.value}="${dom.text(o).trim()}"`
          );
          if (opts.length) line += ` options=[${opts.join(", ")}]`;
        }

        if (!append(line + "\n")) return;
      }

      // Recurse children (including shadow DOM)
      const nextIndent = shouldShow && visible ? indent + "  " : indent;
      const shadow = dom.shadowRoot(el);
      if (shadow) {
        for (const child of shadow.children) {
          walk(child, depth + 1, nextIndent);
        }
      }
      for (const child of dom.children(el)) {
        walk(child, depth + 1, nextIndent);
      }
    }

    let root = dom.docBody();
    if (startRefId) {
      const el = resolveRef(startRefId);
      if (el) root = el;
      else return { error: `Error: ref_id "${startRefId}" not found or element was garbage collected.` };
    }

    walk(root, 0, "");
    return output;
  }

  // --- Page text extraction ---
  function getPageText() {
    const selectors = [
      "article",
      "main",
      '[class*="articleBody"]',
      '[class*="post-content"]',
      '[class*="entry-content"]',
      '[role="main"]',
      ".content",
      "#content",
    ];
    let source = null;
    for (const sel of selectors) {
      source = dom.docQuery(sel);
      if (source) break;
    }
    if (!source) source = dom.docBody();

    const title = dom.docTitle();
    const url = location.href;
    const tag = dom.tag(source);

    // Clean text: remove script/style content, collapse whitespace. source can be a <form> matched
    // by selector (.content, #content, [role="main"]), so cloneNode/querySelectorAll go through the
    // captured prototype methods rather than direct calls, which a named control can replace.
    const clone = cloneNodeFn.call(source, true);
    querySelectorAllFn.call(clone, "script, style, noscript, template, svg").forEach((el) => el.remove());
    const text = dom.text(clone).replace(/\s+/g, " ").trim();

    return JSON.stringify({ title, url, sourceTag: tag, text: text.substring(0, 100000) });
  }

  // --- Element finding ---
  function findElements(query) {
    const q = query.toLowerCase();
    const results = [];

    // Collect all elements including those inside shadow roots
    function collectAll(root) {
      const elements = [];
      for (const el of root.querySelectorAll("*")) {
        elements.push(el);
        const shadow = dom.shadowRoot(el);
        if (shadow) {
          elements.push(...collectAll(shadow));
        }
      }
      return elements;
    }

    const all = collectAll(document);

    for (const el of all) {
      if (results.length >= 20) break;
      if (!isVisible(el)) continue;

      const tag = dom.tag(el);
      if (["script", "style", "noscript", "template"].includes(tag)) continue;

      const role = getRole(el) || "";
      const name = getAccessibleName(el) || "";
      const text = dom.text(el).trim().substring(0, 200);
      // dom.attr can return null (attribute absent); dom.str turns that into "" for interpolation
      // below (a bare null would otherwise stringify as the text "null").
      const placeholder = dom.str(dom.attr(el, "placeholder"));
      const ariaLabel = dom.str(dom.attr(el, "aria-label"));
      const title = dom.str(dom.attr(el, "title"));
      // The type ATTRIBUTE loses the IDL default (e.g. a plain <button> is type "submit" with no
      // attribute at all), so read the property for the HTML elements that own it instead.
      const type = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement || el instanceof HTMLButtonElement ? el.type : "";

      const searchable = `${role} ${name} ${text} ${placeholder} ${ariaLabel} ${title} ${type} ${tag}`.toLowerCase();

      if (searchable.includes(q)) {
        const ref = getOrAssignRef(el);
        const rect = dom.rect(el);
        // Round before deciding in/out of viewport (not after): a float center right at the
        // edge (e.g. innerHeight - 0.5) is genuinely inside, but rounds to a pixel that isn't,
        // and coordinates always report the rounded value. Deciding on the unrounded float
        // would disagree with the very point a click actually lands on.
        const x = Math.round(rect.x + rect.width / 2);
        const y = Math.round(rect.y + rect.height / 2);
        results.push({
          ref,
          role: role || tag,
          name: name || text.substring(0, 80),
          coordinates: [x, y],
          inViewport: x >= 0 && x < innerWidth && y >= 0 && y < innerHeight && !clippedByAncestor(x, y, el),
        });
      }
    }
    return results;
  }

  // --- Form input ---

  // Find the actual input/textarea/select inside an element, traversing shadow DOM. el can be a
  // <form>, so every read goes through dom.
  function findInputInside(el) {
    if (["input", "textarea", "select"].includes(dom.tag(el))) return el;

    // Check shadow DOM first
    const root = dom.shadowRoot(el) || el;
    const inner = dom.query(root, "input, textarea, select");
    if (inner) return inner;

    // Recurse into shadow roots of children
    for (const child of dom.queryAll(root, "*")) {
      const shadow = dom.shadowRoot(child);
      if (shadow) {
        const deep = dom.query(shadow, "input, textarea, select");
        if (deep) return deep;
      }
    }
    return null;
  }

  // Find a file input (self, descendant, or inside shadow DOM) for uploads.
  function findFileInput(el) {
    const isFile = (n) => n instanceof HTMLInputElement && n.type === "file";
    if (isFile(el)) return el;
    const root = dom.shadowRoot(el) || el;
    const inner = dom.query(root, 'input[type="file"]');
    if (isFile(inner)) return inner;
    for (const child of dom.queryAll(root, "*")) {
      const shadow = dom.shadowRoot(child);
      if (shadow) {
        const deep = dom.query(shadow, 'input[type="file"]');
        if (isFile(deep)) return deep;
      }
    }
    return null;
  }

  // Mark the file input for a ref with a unique attribute so the background page
  // can locate the same node from CDP. Content scripts share the page DOM, so
  // the attribute is visible to CDP DOM.querySelector.
  function markFileInput(refId) {
    const el = resolveRef(refId);
    if (!el) return { error: `Element ${refId} not found or was garbage collected.` };
    const input = findFileInput(el);
    if (!input) return { error: `No file input found for ${refId}.` };
    const token = `mcp_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    input.setAttribute("data-mcp-file-input", token);
    return { token };
  }

  function unmarkFileInput(refId) {
    const el = resolveRef(refId);
    if (el) {
      const input = findFileInput(el);
      if (input) input.removeAttribute("data-mcp-file-input");
    }
    return { ok: true };
  }

  // Best-effort image upload: decode base64 into a File and set it on the ref'd
  // file input via DataTransfer, then dispatch input/change. Some sites gate
  // hidden file inputs on trusted events, so this may not work everywhere.
  function uploadImage(refId, base64, filename, mimeType) {
    const el = resolveRef(refId);
    if (!el) return { error: `Element ${refId} not found or was garbage collected.` };
    const input = findFileInput(el);
    if (!input) return { error: `No file input found for ${refId}.` };

    let bytes;
    try {
      const bin = atob(base64);
      bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    } catch {
      return { error: "Failed to decode image data." };
    }

    const file = new File([bytes], filename || "image.png", { type: mimeType || "image/png" });
    const dt = new DataTransfer();
    dt.items.add(file);
    try {
      input.files = dt.files;
    } catch (e) {
      return { error: `Could not set files on the input: ${e.message}` };
    }
    input.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    input.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
    return { success: true, name: file.name, size: file.size };
  }

  // The target can be the ref'd element itself, a <form> for example, so each branch below is
  // guarded by instanceof before it reads a property, and the rest goes through captured methods.
  // A target with no value to set is an error: assigning el.value there only made an expando
  // that the reply reported as a success while the page showed nothing.
  function setFormValue(refId, value) {
    const el = resolveRef(refId);
    if (!el) return { error: `Element ${refId} not found or was garbage collected.` };

    dom.scrollIntoView(el, { block: "center", behavior: "instant" });

    // Resolve the actual form element (may be inside shadow DOM)
    const target = findInputInside(el) || el;
    let readBack = () => target.value;

    if (target instanceof HTMLSelectElement) {
      const opt = Array.from(target.options).find(
        (o) => o.value === String(value) || dom.text(o).trim() === String(value)
      );
      // Setting a value no option has would clear the selection instead.
      if (!opt) return { error: `No option with the value or text "${value}" in this select.` };
      target.value = opt.value;
    } else if (target instanceof HTMLInputElement && (target.type === "checkbox" || target.type === "radio")) {
      const shouldCheck = typeof value === "boolean" ? value : value === "true";
      if (target.checked !== shouldCheck) target.click();
      return { success: true, checked: target.checked };
    } else if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
      // Use the native setter for actual input/textarea elements
      const proto = target instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, "value").set.call(target, String(value));
    } else if (target instanceof HTMLElement && isContentEditableGet.call(target)) {
      textContentSet.call(target, String(value));
      readBack = () => dom.text(target);
    } else {
      return { error: `Cannot set a value on <${dom.tag(target)}>. No input, textarea, select or editable element found at or inside it.` };
    }

    // Dispatch events on the target (bubbles up through shadow DOM)
    dispatchEventFn.call(target, new Event("input", { bubbles: true, composed: true }));
    dispatchEventFn.call(target, new Event("change", { bubbles: true, composed: true }));

    return { success: true, value: readBack() };
  }

  // --- Click targeting: describe what's at a point, scroll refs into view, hit-test ---

  // The flat-tree parent of a node: its assigned slot if it's been distributed into one
  // (slotted content lives in the light DOM, not as a child of the shadow tree it renders
  // into), else a ShadowRoot's host once its own parentNode chain runs out, else its regular
  // parentNode. Node.contains() and Element.closest() never cross a shadow boundary, so a
  // plain ancestor walk misses slotted content and shadow-internal nodes; walking the flat
  // tree instead follows what's actually rendered on screen.
  function flatTreeParent(node) {
    if (node instanceof Element) {
      const slot = assignedSlotGet.call(node);
      if (slot) return slot;
    }
    if (node instanceof ShadowRoot) return node.host;
    return dom.parentNode(node);
  }

  // Whether `hit` is `target` or a flat-tree descendant of it (see flatTreeParent).
  function isInFlatTree(hit, target) {
    let n = hit;
    while (n) {
      if (n === target) return true;
      n = flatTreeParent(n);
    }
    return false;
  }

  const INTERACTIVE_SELECTOR = 'a[href], button, input, select, textarea, label, summary, [role="button"], [role="link"], [role="checkbox"], [role="menuitem"], [role="tab"], [role="option"], [contenteditable], [onclick]';

  // Hit-testing often lands on a decorative inner node (an icon's <path>, a styled <span>)
  // rather than the interactive element it decorates. Walk the flat tree up from the raw hit
  // and describe the nearest thing that actually looks clickable, falling back to the raw hit
  // itself when nothing on the way up matches.
  function nearestInteractive(hit) {
    let n = hit;
    while (n) {
      if (n instanceof Element && dom.matches(n, INTERACTIVE_SELECTOR)) return n;
      n = flatTreeParent(n);
    }
    return hit;
  }

  // True when the point (x, y) falls outside the visible (scrolled) area of some clipping
  // ancestor in el's actual containing-block chain — not its plain DOM ancestor chain. The
  // page-viewport check alone can't see this: an element's own rect is still computed in full
  // even when a container clips it from view, so a target can pass that check while still
  // being invisible inside its own scroll container. But a naive "check every ancestor's
  // overflow" walk over-clips: a position:fixed element's only clip is the viewport itself,
  // regardless of what any ancestor's overflow does; and an absolutely positioned box's
  // containing block is its nearest *non-static* ancestor, so it escapes (is not clipped by)
  // any unpositioned overflow:hidden wrapper in between (the classic "menu that escapes a
  // card" technique). html is always skipped (its own overflow either controls the viewport
  // directly or is superseded), but body is skipped only when html's own overflow is fully
  // visible on both axes — that's the only case where body's overflow propagates to become the
  // viewport's scrolling behaviour. Once html's overflow is anything else, html becomes the
  // designated root scrolling element and body reverts to an ordinary block whose own overflow
  // really does clip its own content.
  function clippedByAncestor(x, y, el) {
    let pos = getComputedStyle(el).position;
    if (pos === "fixed") return false;

    const htmlStyle = getComputedStyle(dom.docDocumentElement());
    const bodyOverflowPropagates = htmlStyle.overflowX === "visible" && htmlStyle.overflowY === "visible";

    let node = flatTreeParent(el);
    while (node) {
      if (!(node instanceof Element)) { node = flatTreeParent(node); continue; }
      const tag = dom.tag(node);
      if (tag === "html" || (tag === "body" && bodyOverflowPropagates)) { node = flatTreeParent(node); continue; }

      const nodeStyle = getComputedStyle(node);
      const nodePosition = nodeStyle.position;
      if (pos === "absolute" && nodePosition === "static") {
        // Not this element's containing block, so its overflow can't clip it either.
        node = flatTreeParent(node);
        continue;
      }

      const clipsX = nodeStyle.overflowX !== "visible";
      const clipsY = nodeStyle.overflowY !== "visible";
      if (clipsX || clipsY) {
        const r = dom.rect(node);
        if ((clipsX && (x < r.x || x >= r.x + r.width)) || (clipsY && (y < r.y || y >= r.y + r.height))) return true;
      }

      if (nodePosition === "fixed") return false;
      pos = nodePosition;
      node = flatTreeParent(node);
    }
    return false;
  }

  // tag + #id + .firstClass + ' "name"' (accessible name, clipped to 40 chars), the whole
  // string capped at 80 chars. E.g. `button#go.primary "Sign in"`.
  function describeElement(el) {
    if (!el) return "(nothing)";
    const tag = dom.tag(el);
    const id = dom.str(dom.attr(el, "id"));
    const firstClass = dom.str(dom.attr(el, "class")).trim().split(/\s+/)[0] || "";
    const name = getAccessibleName(el);
    let desc = tag;
    if (id) desc += `#${id}`;
    if (firstClass) desc += `.${firstClass}`;
    if (name) desc += ` "${name.slice(0, 40)}"`;
    return desc.slice(0, 80);
  }

  // document.elementFromPoint always returns the shadow host, never a node inside an open
  // shadow tree, so descend by re-querying each open shadow root at the same point until it
  // stops finding something new.
  function deepElementFromPoint(x, y) {
    let el = dom.docElementFromPoint(x, y);
    while (el) {
      const root = dom.shadowRoot(el);
      if (!root) break;
      const inner = root.elementFromPoint(x, y);
      if (!inner || inner === el) break;
      el = inner;
    }
    return el;
  }

  // The <label> enclosing `hit`, walking the flat tree (see flatTreeParent) rather than
  // dom.closest: a label whose visible content is drawn inside a shadow root (an icon custom
  // element, say) needs to cross that shadow boundary to be found at all, and dom.closest
  // never does. Shared by labelNotes and isOwnLabel.
  function enclosingLabel(hit) {
    let n = hit;
    while (n) {
      if (n instanceof HTMLLabelElement) return n;
      n = flatTreeParent(n);
    }
    return null;
  }

  // Shared by getRefTarget and probePoint: warn when the hit point is inside a <label> whose
  // control is missing or disabled, since a click there won't do what it looks like it will.
  // Skipped when interactive content of its own (the same LABEL_ESCAPE_SELECTOR walk isOwnLabel
  // uses, excluding the label's own control) sits between the hit and the label: a browser
  // doesn't forward that click to the label's control at all, so whether that control exists or
  // is disabled is beside the point — e.g. a <button> inside <label for=c> with a disabled #c,
  // or a shadow input inside <label>Name <my-input></label> with no recognized .control.
  function labelNotes(hit) {
    const notes = [];
    const label = enclosingLabel(hit);
    if (label) {
      const control = labelControlGet.call(label);
      let escaped = false;
      let n = hit;
      while (n !== label) {
        if (n !== control && n instanceof Element && dom.matches(n, LABEL_ESCAPE_SELECTOR)) { escaped = true; break; }
        n = flatTreeParent(n);
      }
      if (!escaped) {
        if (!control) notes.push("This label has no associated control, so the click may do nothing.");
        else if (dom.matches(control, ":disabled")) notes.push("This label's control is disabled.");
      }
    }
    return notes;
  }

  // HTML "interactive content" (the spec category, not the broader display set of things that
  // merely *look* clickable): a browser does not forward a click on any of these, nested
  // inside a label, to the label's own control — it activates the nested element instead.
  const LABEL_ESCAPE_SELECTOR = 'a[href], button, input:not([type="hidden"]), select, textarea, details, iframe, embed, audio[controls], video[controls]';

  // Whether `hit` is inside a <label> whose associated control is `target` itself, with no
  // interactive content (a real link, not an ARIA role or onclick handler) between the hit and
  // the label — a click at target's own coordinates reaches target through such a label
  // regardless (browsers forward a plain label click to its control natively), which is
  // exactly the visually-hidden-checkbox pattern, not a real "covered" problem. labelNotes
  // already surfaces a disabled control.
  function isOwnLabel(hit, target) {
    const label = enclosingLabel(hit);
    if (!label || labelControlGet.call(label) !== target) return false;
    let n = hit;
    while (n !== label) {
      if (n !== target && n instanceof Element && dom.matches(n, LABEL_ESCAPE_SELECTOR)) return false;
      n = flatTreeParent(n);
    }
    return true;
  }

  // Scrolls el into view and reports the new rounded center plus whether anything observable
  // actually moved: the target's own center, or the window's scroll position. Either alone can
  // miss a real scroll: a position:sticky target can stay clamped at the same viewport-relative
  // spot across a wide scroll range (its own rect never changes even though window.scrollY
  // moves a lot), and comparing only the rect would call that "didn't scroll".
  function scrollIntoViewIfMoved(el, x, y) {
    const beforeScrollX = scrollX, beforeScrollY = scrollY;
    dom.scrollIntoView(el, { block: "center", inline: "center", behavior: "instant" });
    const rect = dom.rect(el);
    const newX = Math.round(rect.x + rect.width / 2);
    const newY = Math.round(rect.y + rect.height / 2);
    const moved = newX !== x || newY !== y || scrollX !== beforeScrollX || scrollY !== beforeScrollY;
    return { x: newX, y: newY, moved };
  }

  function getRefTarget(refId) {
    const el = resolveRef(refId);
    if (!el) return { error: `Element ${refId} not found. Take a new read_page or find.` };
    if (!dom.isConnected(el)) return { error: `Element ${refId} no longer exists. Take a new read_page or find.` };

    let rect = dom.rect(el);
    if (rect.width === 0 || rect.height === 0) {
      return { error: `Element ${refId} has no size (hidden?).` };
    }

    // Round before deciding in/out of viewport (not after): a float center right at the edge
    // (e.g. innerHeight - 0.5) is genuinely inside, but rounds to a pixel that isn't, and the
    // rounded value is what's actually hit-tested and dispatched. Deciding on the unrounded
    // float would disagree with the very point the click lands on.
    let x = Math.round(rect.x + rect.width / 2);
    let y = Math.round(rect.y + rect.height / 2);
    const outOfView = () => x < 0 || x >= innerWidth || y < 0 || y >= innerHeight;

    let scrolled = false;
    if (outOfView()) {
      const result = scrollIntoViewIfMoved(el, x, y);
      x = result.x;
      y = result.y;
      if (result.moved) scrolled = true;
      if (outOfView()) {
        return { error: `Element ${refId} is outside the viewport and could not be scrolled into view.` };
      }
    }

    let hit = deepElementFromPoint(x, y);
    let covered = !isInFlatTree(hit, el) && !isOwnLabel(hit, el);
    if (covered) {
      // Passing the page-viewport check doesn't mean the element is inside the visible
      // (scrolled) area of its own scroll container(s) — a clipped target can still hit-test
      // to whatever's painted behind it. Try scrolling it into view once more before
      // concluding it's genuinely covered by something else. `scrolled` only becomes true if
      // this actually moves something (e.g. a covered target on a page with nothing to scroll
      // must not claim it scrolled anything).
      const result = scrollIntoViewIfMoved(el, x, y);
      x = result.x;
      y = result.y;
      if (result.moved) scrolled = true;
      hit = deepElementFromPoint(x, y);
      covered = !isInFlatTree(hit, el) && !isOwnLabel(hit, el);
    }

    const shownHit = nearestInteractive(hit);
    const notes = [];
    if (covered) notes.push(`The click point is covered by ${describeElement(shownHit)}.`);
    notes.push(...labelNotes(hit));

    return { x, y, scrolled, hit: describeElement(shownHit), covered, notes };
  }

  function probePoint(x, y) {
    const hit = deepElementFromPoint(x, y);
    return {
      inViewport: x >= 0 && x < innerWidth && y >= 0 && y < innerHeight,
      viewport: `${innerWidth}x${innerHeight}`,
      hit: describeElement(nearestInteractive(hit)),
      notes: labelNotes(hit),
    };
  }

  function scrollToRef(refId) {
    const el = resolveRef(refId);
    if (!el) return { error: `Element ${refId} not found. Take a new read_page or find.` };
    if (!dom.isConnected(el)) return { error: `Element ${refId} no longer exists. Take a new read_page or find.` };
    const rect0 = dom.rect(el);
    if (rect0.width === 0 || rect0.height === 0) {
      return { error: `Element ${refId} has no size (hidden?).` };
    }
    dom.scrollIntoView(el, { block: "center", inline: "center", behavior: "instant" });
    const rect = dom.rect(el);
    const x = Math.round(rect.x + rect.width / 2);
    const y = Math.round(rect.y + rect.height / 2);
    return { x, y, inViewport: x >= 0 && x < innerWidth && y >= 0 && y < innerHeight };
  }

  // --- Message handler ---
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (isBlockedPage()) {
      sendResponse({ result: { error: BLOCKED_PAGE_TEXT } });
      return true;
    }

    if (msg.type === "generateAccessibilityTree") {
      const result = generateAccessibilityTree(msg.options || {});
      sendResponse({ result });
      return true;
    }

    if (msg.type === "getPageText") {
      const result = getPageText();
      sendResponse({ result });
      return true;
    }

    if (msg.type === "findElements") {
      const result = findElements(msg.query);
      sendResponse({ result });
      return true;
    }

    if (msg.type === "setFormValue") {
      const result = setFormValue(msg.ref, msg.value);
      sendResponse({ result });
      return true;
    }

    if (msg.type === "getRefTarget") {
      sendResponse({ result: getRefTarget(msg.ref) });
      return true;
    }

    if (msg.type === "probePoint") {
      sendResponse({ result: probePoint(msg.x, msg.y) });
      return true;
    }

    if (msg.type === "scrollToRef") {
      sendResponse({ result: scrollToRef(msg.ref) });
      return true;
    }

    if (msg.type === "markFileInput") {
      sendResponse({ result: markFileInput(msg.ref) });
      return true;
    }

    if (msg.type === "unmarkFileInput") {
      sendResponse({ result: unmarkFileInput(msg.ref) });
      return true;
    }

    if (msg.type === "uploadImage") {
      sendResponse({ result: uploadImage(msg.ref, msg.base64, msg.filename, msg.mimeType) });
      return true;
    }

    return false;
  });

  // Expose globally for executeScript fallback
  window.__unblockedChrome = {
    generateAccessibilityTree,
    getPageText,
    findElements,
    setFormValue,
    getRefTarget,
    probePoint,
    scrollToRef,
    findFileInput,
    markFileInput,
    unmarkFileInput,
    uploadImage,
    resolveRef,
    elementMap,
  };
})();
