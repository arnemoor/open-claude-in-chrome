// Turns a tool call's raw args into a short summary safe for the audit log: never
// typed text, form values, password fields, or a URL's query string/fragment.
// Classic script, loaded via importScripts (background.js) or a vm context (tests).

const AUDIT_STRING_CLIP = 100;
const AUDIT_SUMMARY_CLIP = 300;
const AUDIT_JS_CODE_CLIP = 500;

// A scheme + "://" + a run of non-whitespace/non-quote/non-bracket characters
// for the host/path part; once a "?" or "#" starts a query/fragment, ")" and "'"
// are valid unencoded characters there (fix round 2, pulled in) so the run
// continues through them too, stopping only at whitespace, a double quote or an
// angle bracket. Good enough to find a URL embedded in a free-text Chrome error
// message.
const URL_TOKEN_RE = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>()?#]*(?:[?#][^\s"<>]*)?/gi;
// A data: URI has no "//" after its scheme, so it never matches URL_TOKEN_RE —
// scrubbed separately, the same way navigateSummary's own data: rule collapses
// one to its length instead of leaving it (and whatever it encodes) verbatim.
// Unlike URL_TOKEN_RE, "<"/">" are not excluded: a data:text/html,... payload
// legitimately contains raw markup, and stopping there would leave it exposed.
const DATA_URI_RE = /\bdata:[^\s"']+/gi;

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
function isBareKeyToken(token) {
  return !token.includes("+") && [...token].length === 1;
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
// literal reading of whatever the caller passed (M4).
function normalizeNavigateUrl(url) {
  if (/^https?:\/\//i.test(url) || url.startsWith("about:") || url.startsWith("chrome:") || url.startsWith("brave:")) return url;
  return `https://${url.replace(/^[a-z]{1,5}:\/+/i, "")}`;
}

function navigateSummary(args) {
  const { url } = args;
  if (url === "back" || url === "forward") return url;
  // M3: match case-insensitively and after trimming ("DATA:...", " data:...").
  if (typeof url === "string" && /^\s*data:/i.test(url)) return `data:[${url.length} chars]`;
  return redactUrl(normalizeNavigateUrl(url));
}

function formInputSummary(args) {
  const { ref, value } = args;
  if (typeof value === "boolean") return `${ref} checked=${value}`;
  if (typeof value === "number") return `${ref} value [number]`;
  return `${ref} value [${String(value).length} chars]`;
}

// I5: replaces the contents of every '...', "..." and `...` literal, and every
// regex literal's body, with [N chars], while leaving comments and surrounding
// code untouched. A template literal's whole span (backtick to its own
// matching backtick) is masked as one unit, including any nested ${...}
// substitutions — those are walked, not masked separately, purely to find the
// TRUE matching backtick without being fooled by a string, a regex, a comment,
// or a further nested template inside the substitution (fix round 2: a bare
// "find the next backtick" scan mistook a nested template's own backtick for
// the outer one's close, leaking the inner template's content as ordinary
// code). Comments (// and /* */) are skipped as comments, not scanned for
// quotes, so a quote inside one no longer desynchronizes the scanner onto a
// later, real secret. A "/" is treated as opening a regex only where an
// expression can start (the position rules below), the same way a JS parser
// itself decides, so ordinary division is never mistaken for one. This is a
// lexical scan, not a full JS parser — it fails closed instead: an unterminated
// string, template, regex or (top-level) block comment has its remainder, to
// the end of input, replaced with [N chars] rather than echoed as real code.

// Punctuation and keywords after which a "/" starts an expression (a regex),
// not a division operator.
const REGEX_OK_PUNCT = new Set(["(", ",", "=", ":", "[", "!", "&", "|", "?", "{", "}", ";", "+", "-", "*", "%", "<", ">", "~", "^"]);
const REGEX_OK_WORDS = new Set(["return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "throw", "do", "else", "yield", "case"]);
const IDENT_CHAR_RE = /[A-Za-z0-9_$]/;

function regexAllowedAfter(lastSig) {
  return lastSig === null || REGEX_OK_PUNCT.has(lastSig) || REGEX_OK_WORDS.has(lastSig);
}

// Returns { next, end }: the updated lastSig and the position after consuming
// one ordinary (non-string/regex/comment) unit starting at `i` — a whole
// identifier/keyword/number run at once, a single REGEX_OK_PUNCT character, or
// (whitespace aside, which never changes lastSig) any other punctuation, which
// is value-like (")", "]", "." and so on: a "/" right after one of those is
// division, so it resets lastSig to a non-preceding marker).
function advancePlainToken(code, i, lastSig) {
  const ch = code[i];
  if (IDENT_CHAR_RE.test(ch)) {
    let j = i + 1;
    while (j < code.length && IDENT_CHAR_RE.test(code[j])) j++;
    return { next: code.slice(i, j), end: j };
  }
  if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") return { next: lastSig, end: i + 1 };
  if (REGEX_OK_PUNCT.has(ch)) return { next: ch, end: i + 1 };
  return { next: "value", end: i + 1 };
}

// Position-finding helpers below never build output themselves — everything
// nested inside a template's ${...} is ultimately discarded into that
// template's own single [N chars] span, so only *where things end* matters
// until control returns to maskJsStringLiterals itself.

function skipStringBody(code, i, quote) {
  const n = code.length;
  while (i < n && code[i] !== quote) i += code[i] === "\\" && i + 1 < n ? 2 : 1;
  return i; // index of the closing quote, or n if never found
}

// Honors \ escapes and does not treat "/" as closing while inside a [...]
// character class (e.g. /[a/b]/).
function skipRegexBody(code, i) {
  const n = code.length;
  let inClass = false;
  while (i < n) {
    const ch = code[i];
    if (ch === "\\" && i + 1 < n) i += 2;
    else if (ch === "[") { inClass = true; i++; }
    else if (ch === "]") { inClass = false; i++; }
    else if (ch === "/" && !inClass) return i;
    else i++;
  }
  return i;
}

function skipBlockCommentBody(code, i) {
  const idx = code.indexOf("*/", i);
  return idx === -1 ? code.length : idx;
}

// Skips code inside a ${...} substitution up to (and past) its own matching
// "}", tracking any {} nesting within it and stepping over any strings,
// templates, regexes or comments along the way so a delimiter inside one of
// those is never mistaken for this substitution's closing brace.
function skipSubstitution(code, i) {
  const n = code.length;
  let depth = 0;
  let lastSig = null;
  while (i < n) {
    const ch = code[i];
    if (ch === "/" && code[i + 1] === "/") { while (i < n && code[i] !== "\n") i++; }
    else if (ch === "/" && code[i + 1] === "*") { i = skipBlockCommentBody(code, i + 2); if (i < n) i += 2; }
    else if (ch === "'" || ch === '"') { i = skipStringBody(code, i + 1, ch); if (i < n) i++; lastSig = "value"; }
    else if (ch === "`") { i = skipTemplateBody(code, i + 1); if (i < n) i++; lastSig = "value"; }
    else if (ch === "/" && regexAllowedAfter(lastSig)) { i = skipRegexBody(code, i + 1); if (i < n) i++; lastSig = "value"; }
    else if (ch === "{") { depth++; i++; lastSig = "{"; }
    else if (ch === "}") { if (depth === 0) return i + 1; depth--; i++; lastSig = "}"; }
    else { const adv = advancePlainToken(code, i, lastSig); lastSig = adv.next; i = adv.end; }
  }
  return i; // unterminated substitution; bubbles up as "template never closed"
}

// Finds a template literal's matching closing backtick, starting right after
// its opening one.
function skipTemplateBody(code, i) {
  const n = code.length;
  while (i < n) {
    const ch = code[i];
    if (ch === "\\" && i + 1 < n) i += 2;
    else if (ch === "`") return i;
    else if (ch === "$" && code[i + 1] === "{") i = skipSubstitution(code, i + 2);
    else i++;
  }
  return i;
}

function maskJsStringLiterals(code) {
  let out = "";
  let i = 0;
  const n = code.length;
  let lastSig = null; // start of input: a "/" here would open a regex
  while (i < n) {
    const ch = code[i];
    if (ch === "/" && code[i + 1] === "/") {
      const start = i;
      while (i < n && code[i] !== "\n") i++;
      out += code.slice(start, i); // comments are kept as-is, never masked
    } else if (ch === "/" && code[i + 1] === "*") {
      const bodyStart = i + 2;
      const end = skipBlockCommentBody(code, bodyStart);
      const closed = end < n;
      if (closed) {
        out += code.slice(i, end + 2);
        i = end + 2;
      } else {
        // Fail closed: an unterminated comment might not really be "just a
        // comment" — don't echo whatever follows as if it were safely inert.
        out += "/*" + `[${n - bodyStart} chars]`;
        i = n;
      }
    } else if (ch === "'" || ch === '"') {
      const start = i + 1;
      const end = skipStringBody(code, start, ch);
      const closed = end < n;
      out += ch + `[${end - start} chars]` + (closed ? ch : "");
      i = closed ? end + 1 : n;
      lastSig = "value";
    } else if (ch === "`") {
      const start = i + 1;
      const end = skipTemplateBody(code, start);
      const closed = end < n;
      out += "`" + `[${end - start} chars]` + (closed ? "`" : "");
      i = closed ? end + 1 : n;
      lastSig = "value";
    } else if (ch === "/" && regexAllowedAfter(lastSig)) {
      const start = i + 1;
      const end = skipRegexBody(code, start);
      const closed = end < n;
      out += "/" + `[${end - start} chars]`;
      if (closed) {
        i = end + 1;
        const flagStart = i;
        while (i < n && /[a-z]/i.test(code[i])) i++;
        out += "/" + code.slice(flagStart, i);
      } else {
        i = n;
      }
      lastSig = "value";
    } else {
      const adv = advancePlainToken(code, i, lastSig);
      out += code.slice(i, adv.end);
      lastSig = adv.next;
      i = adv.end;
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
  if (shouldMaskValue && typeof attributes.value === "string") {
    attributes.value = "*".repeat(attributes.value.length);
  }
  for (const attr of URL_ATTRS) {
    if (typeof attributes[attr] === "string") attributes[attr] = redactUrl(attributes[attr]);
  }
  if (typeof attributes.srcset === "string") attributes.srcset = redactSrcset(attributes.srcset);
  for (const [name, value] of Object.entries(attributes)) {
    if (name === "value" || name === "srcset" || URL_ATTRS.includes(name)) continue; // already handled above
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
// - Meta (type 4): data.href through redactUrl.
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
