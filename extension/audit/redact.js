// Turns a tool call's raw args into a short summary safe for the audit log: never
// typed text, form values, password fields, or a URL's query string/fragment.
// Classic script, loaded via importScripts (background.js) or a vm context (tests).

const AUDIT_STRING_CLIP = 100;
const AUDIT_SUMMARY_CLIP = 300;
const AUDIT_JS_CODE_CLIP = 500;

// A scheme + "://" + the host/path part, then an optional query or fragment.
// The host/path part ends at whitespace, a double quote, "<", ">", "?" or
// "#". "(" and ")" stay in it (fix round 3, item 3), so a path like
// "/a(b?token=..." still reaches its own query, and so does "'" (item 7),
// so a path like "/o'brien?token=..." does too — a "'" only ever over-masks,
// never under-masks, whether it sits in the host/path or (already) in the
// query or fragment. A query or fragment ends only at whitespace, a double
// quote, "<" or ">"; a "'" there is a legal query character and never ends
// the token (fix round 4, item 1). Good enough to find a URL embedded in a
// free-text Chrome error message or a page attribute.
//
// Fix round 3, item 2 (new Important): the scheme's own suffix is bounded to
// {0,31} (any real scheme name is far shorter), not left unbounded. An
// unbounded `[a-z0-9+.-]*` here, combined with \b matching at every letter in
// a long alternating run like "a.a.a...", made the regex engine retry an
// O(remaining-length) "no ':' found" backtrack at O(n) different starting
// points — O(n^2) overall. A 100 KB attribute value cost 4.1s; bounding the
// scheme caps the work at each starting point to a constant, restoring O(n).
const URL_TOKEN_RE = /\b[a-z][a-z0-9+.-]{0,31}:\/\/[^\s"<>?#]*(?:[?#][^\s"<>]*)?/gi;
// A data: URI has no "//" after its scheme, so it never matches URL_TOKEN_RE —
// scrubbed separately, the same way navigateSummary's own data: rule collapses
// one to its length instead of leaving it (and whatever it encodes) verbatim.
// Its payload can hold any character (markup, spaces, quotes), so no character
// marks where it ends: the mask runs from "data:" to the end of the string or
// attribute value (fail closed, fix round 4, item 3).
const DATA_URI_RE = /\bdata:[\s\S]*/i;

function clipTo(s, max) {
  return typeof max === "number" && s.length > max ? `${s.slice(0, max)}…` : s;
}

// Replaces every URL-like token (and every data: URI) in free text with its
// redacted form, then (optionally) clips the result. Used for error/outcome
// text (I1), the generic fallback's string values (M9), and now every rrweb
// attribute value the walker sees (I2) — anywhere a secret could ride in as a
// query string, fragment or data: payload without the text itself being a
// dedicated URL field.
function scrubUrls(text, maxLen) {
  if (typeof text !== "string") return text;
  let scrubbed = text.replace(DATA_URI_RE, (m) => `data:[${m.length} chars]`);
  scrubbed = scrubbed.replace(URL_TOKEN_RE, (m) => redactUrl(m));
  return clipTo(scrubbed, maxLen);
}

function redactUrl(url) {
  try {
    const u = new URL(url);
    const hadSearch = u.search !== "";
    const hadHash = u.hash !== "";
    // Clear credentials/query/fragment on the URL object itself (not by hand-
    // rebuilding protocol+host+pathname) so a scheme the WHATWG parser treats as
    // "not special" — about:, chrome:, a bare custom scheme — keeps its own
    // shape (e.g. "about:blank") instead of gaining a synthetic "//" host section.
    u.username = "";
    u.password = "";
    u.search = "";
    u.hash = "";
    let s = u.href;
    if (hadSearch) s += "?…";
    if (hadHash) s += "#…";
    return s;
  } catch {
    return "[unparseable url]";
  }
}

function clipDeep(value, max) {
  if (typeof value === "string") return scrubUrls(value, max);
  if (Array.isArray(value)) return value.map((v) => clipDeep(v, max));
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = clipDeep(v, max);
    return out;
  }
  return value;
}

// I5: a run of `key` calls, one bare printable character at a time, is how the
// `key` action can type real text while bypassing `type`'s own redaction (see
// background.js's charDefinition/keyDefinition). Every named key (Enter, Tab,
// F5, ...) and every modifier combo (ctrl+a, cmd+shift+t) is at least 2
// characters or contains "+", so a token that is exactly one character with no
// "+" is unambiguously a bare key press, never a name.
//
// Item 8: "shift" plus exactly one printable character is the same bypass —
// it types one real character (a capital letter, or a shifted symbol) per
// call, just with shift held. A combo with any OTHER modifier (ctrl+a,
// cmd+shift+t) is a real shortcut, not text entry, and stays as-is.
function isBareKeyToken(token) {
  if (!token.includes("+") && [...token].length === 1) return true;
  const parts = token.split("+");
  return parts.length === 2 && parts[0] === "shift" && [...parts[1]].length === 1;
}

function keySummary(text) {
  const tokens = (text || "").split(" ").filter(Boolean);
  if (tokens.length > 0 && tokens.every(isBareKeyToken)) return `[${tokens.length} keys]`;
  const out = [];
  let runLen = 0;
  for (const t of tokens) {
    if (isBareKeyToken(t)) {
      runLen++;
    } else {
      if (runLen > 0) { out.push(`[${runLen} keys]`); runLen = 0; }
      out.push(t);
    }
  }
  if (runLen > 0) out.push(`[${runLen} keys]`);
  return out.join(" ");
}

function computerSummary(args) {
  let s = String(args.action);
  if (args.coordinate) s += ` at (${args.coordinate[0]}, ${args.coordinate[1]})`;
  if (args.ref) s += ` ${args.ref}`;
  switch (args.action) {
    case "type":
      s += ` [${(args.text || "").length} chars]`;
      break;
    case "key":
      s += ` ${keySummary(args.text)}`;
      break;
    case "scroll":
      s += ` ${args.scroll_direction || "down"} ${args.scroll_amount ?? 3}`;
      break;
    case "zoom":
      // M4: a malformed region (not an array) must not throw — the action is
      // still recorded, just without the region detail.
      if (Array.isArray(args.region)) s += ` region [${args.region.join(", ")}]`;
      break;
  }
  return s;
}

// Mirrors the navigate handler's own scheme-less normalization (background.js)
// so the audit summary reflects the URL it will actually navigate to, not a
// literal reading of whatever the caller passed (M4). Named distinctly from
// background.js's own like-named helper (fix round 3, item 5): redact.js is a
// classic script sharing the worker's global scope with everything else
// importScripts loads, and on the integration branch (Task 12) background.js
// declares its own `normalizeNavigateUrl(input, ownExtensionId)` — importScripts
// runs after background.js's own declarations are hoisted, so the identically-
// named function here silently replaced it and broke navigate.
function auditNavigateTarget(url) {
  if (/^https?:\/\//i.test(url) || url.startsWith("about:") || url.startsWith("chrome:") || url.startsWith("brave:")) return url;
  return `https://${url.replace(/^[a-z]{1,5}:\/+/i, "")}`;
}

function navigateSummary(args) {
  const { url } = args;
  if (url === "back" || url === "forward") return url;
  // M3: match case-insensitively and after trimming ("DATA:...", " data:...").
  if (typeof url === "string" && /^\s*data:/i.test(url)) return `data:[${url.length} chars]`;
  return redactUrl(auditNavigateTarget(url));
}

function formInputSummary(args) {
  const { ref, value } = args;
  if (typeof value === "boolean") return `${ref} checked=${value}`;
  if (typeof value === "number") return `${ref} value [number]`;
  return `${ref} value [${String(value).length} chars]`;
}

// I5: replaces the contents of every '...', "..." and `...` literal with
// [N chars], while leaving comments and surrounding code untouched. A template
// literal's whole span (backtick to its own matching backtick) is masked as
// one unit, including any nested ${...} substitutions — those are walked (via
// skipTemplate below), not masked separately, purely to find the TRUE matching
// backtick without being fooled by a string, a comment, or a further nested
// template inside the substitution. Comments (// and /* */) are skipped as
// comments, not scanned for quotes, so a quote inside one no longer
// desynchronizes the scanner onto a later, real secret. A // comment ends at
// any JavaScript line terminator (fix round 4, item 4): LF, CR, U+2028 or
// U+2029, not only at LF, or the code after a CR would pass as comment text.
//
// Fix round 3, item 1 (binding): earlier drafts also tried to guess whether a
// "/" opened a regex literal or was a division operator, by the token before
// it. That heuristic itself leaked real secrets — 13 of 61 adversarial inputs
// in re-review, the main family a postfix "++"/"--" right before a "/" (e.g.
// `done++ / total`), which was misjudged as a regex opener and swallowed
// everything up to a LATER, unrelated "/" inside a real string, un-masking it.
// The rule now: outside a string, a template or a comment, ANY "/" that isn't
// "//" or "/*" ends the kept part — everything from that "/" to the end of
// input becomes one [N chars] span. This over-masks a real regex or division,
// but it can no longer leak a secret no matter how the "/" was introduced.
//
// This is a lexical scan, not a full JS parser — it fails closed instead: an
// unterminated string, template or (top-level) block comment has its
// remainder, to the end of input, replaced with [N chars] rather than echoed
// as real code. Nesting inside skipTemplate uses an explicit stack, not
// recursion, and gives up (failing closed) past MAX_TEMPLATE_DEPTH nested
// template levels, so a script holding thousands of nested template literals
// cannot throw a RangeError and drop the whole action unrecorded.

const MAX_TEMPLATE_DEPTH = 100;

function lineCommentEnd(code, i) {
  while (i < code.length && !"\n\r\u2028\u2029".includes(code[i])) i++;
  return i;
}

// Finds the position of a template literal's TRUE matching closing backtick,
// given the position right after its OPENING one. A "${" inside it starts a
// substitution — ordinary code, which can itself hold strings, comments and
// further nested templates (each with their own "${...}") — so an explicit
// stack tracks every level currently open: "template" (scanning that level's
// own literal text) or a number (scanning a substitution's code, counting its
// own unmatched "{" so the "}" that closes it is never confused with one
// nested deeper inside it). A bare "/" encountered anywhere in this walk — at
// any depth — means nothing past it can be trusted either, so the whole
// search fails closed (returns n, "never closed") from there, same as running
// out of input while any level is still open.
//
// The cap counts template frames only (fix round 4, item 6). A level pushes
// two frames, its template and the substitution it is nested in, so a cap on
// the stack length failed closed from level 51. The stack still stays bounded:
// a substitution frame is only ever pushed onto a template frame.
function skipTemplate(code, start) {
  const n = code.length;
  let i = start;
  const stack = ["template"];
  let templates = 1;
  while (i < n) {
    const top = stack[stack.length - 1];
    const ch = code[i];

    if (top === "template") {
      if (ch === "\\" && i + 1 < n) { i += 2; continue; }
      if (ch === "`") {
        if (stack.length === 1) return i; // our own outermost template's true close
        stack.pop();
        templates--;
        i++;
        continue;
      }
      if (ch === "$" && code[i + 1] === "{") {
        i += 2;
        stack.push(0);
        continue;
      }
      i++;
      continue;
    }

    // top is a number: scanning code inside a "${...}" substitution.
    if (ch === "/" && code[i + 1] === "/") { i = lineCommentEnd(code, i); continue; }
    if (ch === "/" && code[i + 1] === "*") {
      const end = code.indexOf("*/", i + 2);
      if (end === -1) return n;
      i = end + 2;
      continue;
    }
    if (ch === "'" || ch === '"') {
      let j = i + 1;
      while (j < n && code[j] !== ch) j += code[j] === "\\" && j + 1 < n ? 2 : 1;
      if (j >= n) return n;
      i = j + 1;
      continue;
    }
    if (ch === "`") {
      i++;
      if (templates >= MAX_TEMPLATE_DEPTH) return n;
      templates++;
      stack.push("template");
      continue;
    }
    if (ch === "/") return n; // fail closed: see the file-level comment above
    if (ch === "{") { stack[stack.length - 1] = top + 1; i++; continue; }
    if (ch === "}") {
      if (top === 0) { stack.pop(); i++; continue; }
      stack[stack.length - 1] = top - 1;
      i++;
      continue;
    }
    i++;
  }
  return n; // ran out of input before this template's own closing backtick
}

function maskJsStringLiterals(code) {
  let out = "";
  let i = 0;
  const n = code.length;
  while (i < n) {
    const ch = code[i];
    if (ch === "/" && code[i + 1] === "/") {
      const start = i;
      i = lineCommentEnd(code, i);
      out += code.slice(start, i); // comments are kept as-is, never masked
    } else if (ch === "/" && code[i + 1] === "*") {
      const bodyStart = i + 2;
      const end = code.indexOf("*/", bodyStart);
      const closed = end !== -1;
      if (closed) {
        out += code.slice(i, end + 2);
        i = end + 2;
      } else {
        // Fail closed: an unterminated comment might not really be "just a
        // comment" — don't echo whatever follows as if it were safely inert.
        out += "/*" + `[${n - bodyStart} chars]`;
        return out;
      }
    } else if (ch === "'" || ch === '"') {
      const start = i + 1;
      let j = start;
      while (j < n && code[j] !== ch) j += code[j] === "\\" && j + 1 < n ? 2 : 1;
      const closed = j < n;
      out += ch + `[${j - start} chars]` + (closed ? ch : "");
      if (!closed) return out;
      i = j + 1;
    } else if (ch === "`") {
      const start = i + 1;
      const end = skipTemplate(code, start);
      const closed = end < n;
      out += "`" + `[${end - start} chars]` + (closed ? "`" : "");
      if (!closed) return out;
      i = end + 1;
    } else if (ch === "/") {
      // Item 1's binding rule: stop guessing whether this is a regex or a
      // division — either way we cannot safely keep parsing past it, so
      // everything from here to the end of input becomes one opaque span.
      out += `[${n - i} chars]`;
      return out;
    } else {
      out += ch;
      i++;
    }
  }
  return out;
}

function javascriptSummary(args) {
  const code = maskJsStringLiterals(args.text || "");
  if (code.length <= AUDIT_JS_CODE_CLIP) return code;
  return `${code.slice(0, AUDIT_JS_CODE_CLIP)} … (+${code.length - AUDIT_JS_CODE_CLIP} chars)`;
}

function fileUploadSummary(args) {
  const paths = Array.isArray(args.paths) ? args.paths : [];
  return `${args.ref} paths: ${paths.join(", ")}`;
}

// M4: upload_image can target a ref or a coordinate; show whichever was given
// instead of the literal word "undefined" when there is no ref.
function uploadImageSummary(args) {
  const target = args.ref ? args.ref : Array.isArray(args.coordinate) ? `at (${args.coordinate[0]}, ${args.coordinate[1]})` : "";
  return `imageId ${args.imageId} ${target}`.trimEnd();
}

function browserBatchSummary(args) {
  const actions = Array.isArray(args.actions) ? args.actions : [];
  return `batch of ${actions.length}: ${actions.map((a) => a?.name).join(", ")}`;
}

function genericSummary(args) {
  const { tabId, ...rest } = args || {};
  let json = JSON.stringify(clipDeep(rest, AUDIT_STRING_CLIP));
  if (json.length > AUDIT_SUMMARY_CLIP) json = `${json.slice(0, AUDIT_SUMMARY_CLIP)}…`;
  return json;
}

// --- rrweb event redaction (I1/I2), run in the worker (Audit.onRecorderEvents)
// before a recorder batch is stored, so a recorder in any document cannot pass
// through a raw secret regardless of what it actually sent. ---

// I2: attributes that carry a URL, wherever they appear (any tag) — checked by
// name only, since the attribute name alone identifies it as URL-bearing.
const URL_ATTRS = ["href", "src", "action", "formaction", "poster"];

// "url descriptor, url descriptor, ..." — redact each URL, keep its descriptor
// (a width like "480w" or a density like "2x") untouched.
function redactSrcset(value) {
  return value.split(",").map((part) => {
    const trimmed = part.trim();
    const spaceIdx = trimmed.indexOf(" ");
    if (spaceIdx === -1) return redactUrl(trimmed);
    return redactUrl(trimmed.slice(0, spaceIdx)) + trimmed.slice(spaceIdx);
  }).join(", ");
}

// I1: masks input/textarea `value` attributes with `*` of the same length,
// when `shouldMaskValue` is true. In a full snapshot or an `adds` entry the
// tag is always directly known, so the caller passes it positively (input or
// textarea only — an <option>'s value is page content, not a typed secret).
// For an attribute mutation, the caller instead fails closed (controller
// ruling, fix round 2): an id the walker does not recognize at all — which
// happens for real after a worker restart (the tag map lives only in memory)
// or any batch dropped before reaching the walker — is masked too, accepting
// that a button's or meter's value gets masked as a rare, acceptable cost. A
// tag *positively* known to be something else stays untouched either way.
// I2 (pulled in): every other string attribute is also run through scrubUrls,
// since a URL can ride in as free text on an attribute that isn't one of the
// dedicated URL_ATTRS (e.g. a <meta property="og:url" content="...?token=...">).
function redactAttributes(shouldMaskValue, attributes) {
  if (!attributes || typeof attributes !== "object") return;
  if (typeof attributes.value === "string") {
    // Fix round 3, item 4 (pulled): a value the controller's ruling keeps
    // (an <option>'s or a <button>'s — page content, not a typed secret) can
    // still carry a URL's query as its own text (e.g. an <option value="https:
    // //...?token=...">) — scrub that even though the value itself isn't
    // asterisk-masked.
    if (shouldMaskValue) attributes.value = "*".repeat(attributes.value.length);
    else attributes.value = scrubUrls(attributes.value);
  }
  for (const attr of URL_ATTRS) {
    if (typeof attributes[attr] === "string") attributes[attr] = redactUrl(attributes[attr]);
  }
  if (typeof attributes.srcset === "string") attributes.srcset = redactSrcset(attributes.srcset);
  // A signed image URL's query can ride in a style value in any shape rrweb
  // sends (fix round 4, item 2). A style is a string in a snapshot, and in a
  // mutation whose diff would be longer than the whole value (the usual case
  // for el.style.x = ... on an element without an inline style). Otherwise it
  // is a diff object, CSS property -> new value, where a value is a string, a
  // [value, priority] array for an !important one, or false for a removed
  // property.
  if (typeof attributes.style === "string") {
    attributes.style = scrubUrls(attributes.style);
  } else if (attributes.style && typeof attributes.style === "object") {
    for (const [prop, value] of Object.entries(attributes.style)) {
      if (typeof value === "string") {
        attributes.style[prop] = scrubUrls(value);
      } else if (Array.isArray(value)) {
        for (let k = 0; k < value.length; k++) {
          if (typeof value[k] === "string") value[k] = scrubUrls(value[k]);
        }
      }
    }
  }
  for (const [name, value] of Object.entries(attributes)) {
    if (name === "value" || name === "srcset" || name === "style" || URL_ATTRS.includes(name)) continue; // already handled above
    if (typeof value === "string") attributes[name] = scrubUrls(value);
  }
}

function isMaskableValueTag(tagName) {
  return tagName === "input" || tagName === "textarea";
}

// Walks a snapshot (or newly-added) node and its descendants: records each
// element's rrweb id -> lowercase tagName into `knownTags` (so a later,
// separate mutation event on the same id can be classified) and redacts it
// in place.
function walkSnapshotNode(node, knownTags) {
  if (!node || typeof node !== "object") return;
  if (node.type === 2 /* Element */ && typeof node.tagName === "string") {
    const tagName = node.tagName.toLowerCase();
    if (node.id != null) knownTags.set(node.id, tagName);
    redactAttributes(isMaskableValueTag(tagName), node.attributes);
  }
  if (Array.isArray(node.childNodes)) {
    for (const child of node.childNodes) walkSnapshotNode(child, knownTags);
  }
}

// Redacts an rrweb event batch in place before it is relayed or stored:
// - Meta (type 4): data.href through redactUrl. A Meta event always starts a
//   fresh document, the same one its own FullSnapshot is about to describe,
//   so `knownTags` is cleared here too (item 10) — not only on the
//   FullSnapshot below — so a mutation for a reused id that reaches the
//   walker before that FullSnapshot's own arrival (the two can land in
//   different batches) is never read against a stale, wrong mapping left
//   over from the previous document.
// - FullSnapshot (type 2): every element node, via walkSnapshotNode. A full
//   snapshot means a fresh document — rrweb's node ids restart from 1 there,
//   so `knownTags` is cleared first; a stale id from a previous document would
//   otherwise be not just useless but actively wrong (id 9 could now be a
//   <div> instead of the <input> it used to be).
// - IncrementalSnapshot Mutation (type 3, source 0): each `adds` node via
//   walkSnapshotNode, and each `attributes` entry via knownTags — masking
//   (controller ruling) unless the id is *positively* known to be something
//   other than input/textarea, so an id the walker has never seen fails
//   closed instead of passing a raw value through. A node's defining
//   snapshot/add can land in an earlier batch than a later mutation on it —
//   the caller keeps `knownTags` across calls for that reason.
// Returns `events` (mutated in place) for convenient chaining.
function redactEvents(events, knownTags) {
  for (const event of events || []) {
    if (!event || typeof event !== "object") continue;
    if (event.type === 4) {
      knownTags.clear();
      if (event.data && typeof event.data.href === "string") event.data.href = redactUrl(event.data.href);
    } else if (event.type === 2) {
      if (event.data && event.data.node) {
        knownTags.clear();
        walkSnapshotNode(event.data.node, knownTags);
      }
    } else if (event.type === 3 && event.data && event.data.source === 0) {
      for (const add of event.data.adds || []) walkSnapshotNode(add.node, knownTags);
      for (const mutation of event.data.attributes || []) {
        const tagName = knownTags.get(mutation.id);
        redactAttributes(tagName === undefined || isMaskableValueTag(tagName), mutation.attributes);
      }
    }
  }
  return events;
}

function auditSummary(tool, args) {
  args = args || {};
  switch (tool) {
    case "computer": return computerSummary(args);
    case "navigate": return navigateSummary(args);
    case "form_input": return formInputSummary(args);
    case "javascript_tool": return javascriptSummary(args);
    case "file_upload": return fileUploadSummary(args);
    case "find": return `query: ${args.query}`;
    case "upload_image": return uploadImageSummary(args);
    case "browser_batch": return browserBatchSummary(args);
    default: return genericSummary(args);
  }
}
