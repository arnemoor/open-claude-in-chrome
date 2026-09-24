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
  const getAttributeFn = Element.prototype.getAttribute;
  const closestFn = Element.prototype.closest;
  const matchesFn = Element.prototype.matches;
  const rectFn = Element.prototype.getBoundingClientRect;
  const docQueryFn = Document.prototype.querySelector;
  const docByIdFn = Document.prototype.getElementById;
  const docElementFromPointFn = Document.prototype.elementFromPoint;

  function str(value) {
    return typeof value === "string" ? value : "";
  }

  const dom = {
    tag: (el) => (el ? str(tagNameGet.call(el)).toLowerCase() : ""),
    attr: (el, name) => (el ? str(getAttributeFn.call(el, name)) : ""),
    children: (el) => (el ? childrenGet.call(el) : []),
    text: (el) => (el ? str(textContentGet.call(el)) : ""),
    nodeType: (el) => (el ? nodeTypeGet.call(el) : 0),
    shadowRoot: (el) => (el ? shadowRootGet.call(el) : null),
    closest: (el, sel) => (el ? closestFn.call(el, sel) : null),
    matches: (el, sel) => (el ? matchesFn.call(el, sel) : false),
    rect: (el) => (el ? rectFn.call(el) : { x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 }),
    str,
    docTitle: () => str(docTitleGet.call(document)),
    docBody: () => docBodyGet.call(document),
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
    const contentEditable = dom.attr(el, "contenteditable");
    if (contentEditable === "" || contentEditable === "true") return true;
    return false;
  }

  // --- Visibility check ---
  function isVisible(el) {
    if (offsetParentGet.call(el) === null && dom.tag(el) !== "body" && getComputedStyle(el).position !== "fixed") return false;
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

        // Extra info for specific elements
        if (tag === "a" && el.href) line += ` href="${el.href}"`;
        if (tag === "img" && el.src) line += ` src="${el.src.substring(0, 100)}"`;
        if (["input", "textarea"].includes(tag) && el.value) line += ` value="${el.value.substring(0, 100)}"`;
        if (tag === "input") line += ` type="${el.type || "text"}"`;
        const expanded = dom.attr(el, "aria-expanded");
        if (expanded) line += ` expanded=${expanded}`;
        const checked = dom.attr(el, "aria-checked");
        if (checked) line += ` checked=${checked}`;
        const selected = dom.attr(el, "aria-selected");
        if (selected) line += ` selected=${selected}`;
        if (dom.matches(el, ":disabled")) line += " disabled";

        // Select options
        if (tag === "select") {
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
      else return `Error: ref_id "${startRefId}" not found or element was garbage collected.`;
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

    // Clean text: remove script/style content, collapse whitespace
    const clone = source.cloneNode(true);
    clone.querySelectorAll("script, style, noscript, template, svg").forEach((el) => el.remove());
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
      const placeholder = dom.attr(el, "placeholder");
      const ariaLabel = dom.attr(el, "aria-label");
      const title = dom.attr(el, "title");
      const type = dom.attr(el, "type");

      const searchable = `${role} ${name} ${text} ${placeholder} ${ariaLabel} ${title} ${type} ${tag}`.toLowerCase();

      if (searchable.includes(q)) {
        const ref = getOrAssignRef(el);
        const rect = dom.rect(el);
        results.push({
          ref,
          role: role || tag,
          name: name || text.substring(0, 80),
          coordinates: [Math.round(rect.x + rect.width / 2), Math.round(rect.y + rect.height / 2)],
        });
      }
    }
    return results;
  }

  // --- Form input ---

  // Find the actual input/textarea/select inside an element, traversing shadow DOM
  function findInputInside(el) {
    const tag = el.tagName.toLowerCase();
    if (["input", "textarea", "select"].includes(tag)) return el;

    // Check shadow DOM first
    const root = el.shadowRoot || el;
    const inner = root.querySelector("input, textarea, select");
    if (inner) return inner;

    // Recurse into shadow roots of children
    for (const child of root.querySelectorAll("*")) {
      if (child.shadowRoot) {
        const deep = child.shadowRoot.querySelector("input, textarea, select");
        if (deep) return deep;
      }
    }
    return null;
  }

  // Find a file input (self, descendant, or inside shadow DOM) for uploads.
  function findFileInput(el) {
    const isFile = (n) =>
      n.tagName && n.tagName.toLowerCase() === "input" && (n.type || "").toLowerCase() === "file";
    if (isFile(el)) return el;
    const root = el.shadowRoot || el;
    const inner = root.querySelector('input[type="file"]');
    if (inner) return inner;
    for (const child of root.querySelectorAll("*")) {
      if (child.shadowRoot) {
        const deep = child.shadowRoot.querySelector('input[type="file"]');
        if (deep) return deep;
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

  function setFormValue(refId, value) {
    const el = resolveRef(refId);
    if (!el) return { error: `Element ${refId} not found or was garbage collected.` };

    el.scrollIntoView({ block: "center", behavior: "instant" });

    // Resolve the actual form element (may be inside shadow DOM)
    const target = findInputInside(el) || el;
    const tag = target.tagName.toLowerCase();
    const type = (target.type || "").toLowerCase();

    if (tag === "select") {
      const opt = Array.from(target.options).find(
        (o) => o.value === String(value) || o.textContent.trim() === String(value)
      );
      if (opt) {
        target.value = opt.value;
      } else {
        target.value = String(value);
      }
    } else if (type === "checkbox" || type === "radio") {
      const shouldCheck = typeof value === "boolean" ? value : value === "true";
      if (target.checked !== shouldCheck) target.click();
      return { success: true, checked: target.checked };
    } else if (target.contentEditable === "true") {
      target.textContent = String(value);
    } else if (["input", "textarea"].includes(tag)) {
      // Use the native setter for actual input/textarea elements
      const proto = tag === "textarea" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
      if (setter) {
        setter.call(target, String(value));
      } else {
        target.value = String(value);
      }
    } else {
      // Fallback for unknown elements — try direct assignment
      try {
        target.value = String(value);
      } catch {
        return { error: `Cannot set value on <${tag}> element. No input found inside.` };
      }
    }

    // Dispatch events on the target (bubbles up through shadow DOM)
    target.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    target.dispatchEvent(new Event("change", { bubbles: true, composed: true }));

    return { success: true, value: target.value };
  }

  // --- Get element coordinates for ref ---
  function getRefCoordinates(refId) {
    const el = resolveRef(refId);
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    return {
      x: Math.round(rect.x + rect.width / 2),
      y: Math.round(rect.y + rect.height / 2),
    };
  }

  // --- Message handler ---
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
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

    if (msg.type === "getRefCoordinates") {
      const result = getRefCoordinates(msg.ref);
      sendResponse({ result });
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
    getRefCoordinates,
    findFileInput,
    markFileInput,
    unmarkFileInput,
    uploadImage,
    resolveRef,
    elementMap,
  };
})();
