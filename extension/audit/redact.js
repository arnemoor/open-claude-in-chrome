// Turns a tool call's raw args into a short summary safe for the audit log: never
// typed text, form values, password fields, or a URL's query string/fragment.
// Classic script, loaded via importScripts (background.js) or a vm context (tests).

const AUDIT_STRING_CLIP = 100;
const AUDIT_SUMMARY_CLIP = 300;
const AUDIT_JS_CODE_CLIP = 500;

// A scheme + "://" + the host/path part, then an optional query or fragment.
// The host/path part ends at whitespace, a double quote, "<", ">", "?" or
// "#". "(" and ")" stay in it, so a path like "/a(b?token=..." still reaches
// its own query, and so does "'", so a path like "/o'brien?token=..." does too
// — a "'" only ever over-masks, never under-masks, whether it sits in the
// host/path or (already) in the query or fragment. A query or fragment ends
// only at whitespace, a double quote, "<" or ">"; a "'" there is a legal query
// character and never ends the token. Good enough to find a URL embedded in a
// free-text Chrome error message or a page attribute.
//
// The scheme's own suffix is bounded to {0,31} (any real scheme name is far
// shorter), not left unbounded. An unbounded `[a-z0-9+.-]*` here, combined
// with \b matching at every letter in a long alternating run like
// "a.a.a...", made the regex engine retry an
// O(remaining-length) "no ':' found" backtrack at O(n) different starting
// points — O(n^2) overall. A 100 KB attribute value cost 4.1s; bounding the
// scheme caps the work at each starting point to a constant, restoring O(n).
const URL_TOKEN_RE = /\b[a-z][a-z0-9+.-]{0,31}:\/\/[^\s"<>?#]*(?:[?#][^\s"<>]*)?/gi;
// A data: URI has no "//" after its scheme, so it never matches URL_TOKEN_RE —
// scrubbed separately, the same way navigateSummary's own data: rule collapses
// one to its length instead of leaving it (and whatever it encodes) verbatim.
// Its payload can hold any character (markup, spaces, quotes), so no character
// marks where it ends: the mask runs from "data:" to the end of the string or
// attribute value (fail closed).
const DATA_URI_RE = /\bdata:[\s\S]*/i;

// CSS text (a style attribute string, a style diff value, rrweb's own
// _cssText carrying a whole <style> or inlined stylesheet, a <style>
// element's text, or an adopted stylesheet's rule) mostly holds a data: URI
// in a url(...) token, whose payload has a real end: the closing quote of
// url("...") or url('...'), or the ")" of a bare url(...), with "\" escaping
// the character after it. Masking only that far keeps every rule after a
// data: icon (a Bootstrap-sized stylesheet lost 83% of its rules to the
// mask-to-the-end rule of free text). A data: URI can also sit where no such
// end is known: in a custom property string, image-set("..."), an @import
// string, or a url( token that never closes. The last branch masks any such
// data: to the end of the text, but only where a URI can start. Right after a
// letter, a digit, "_", ".", "#" or "-", "data:" is part of a selector or a
// property name (.no-data::before, table.data:hover, --chart-data:1), so the
// rules after it stay. A quoted data: with no comma and no "\" before the
// string's closing quote holds no payload either: a data: URL needs a comma
// before its payload, and only a CSS escape could encode one. Such a string,
// like content:"data: 5", is masked only up to its closing quote. All
// branches run in one pass, so a masked "data:[N chars]" is never matched
// again. Negated character classes, not a lazy [\s\S]*?, keep the scan linear
// on input that never closes a token.
const CSS_DATA_URI_RE = /\burl\(\s*(?:"(data:(?:[^"\\]|\\[\s\S])*)"|'(data:(?:[^'\\]|\\[\s\S])*)'|(data:(?:[^\s"'()\\]|\\[\s\S])*))\s*\)|(?<=")data:[^"\\,]*(?=")|(?<=')data:[^'\\,]*(?=')|(?<![\w.#-])data:[\s\S]*/gi;

// A URL in CSS text, found in one pass. First a whole url(...) token: its
// payload ends at the closing quote of url("...") or url('...'), or at the ")"
// of a bare url(...), and "\" escapes the character after it. Failing that,
// any other URL token (in a string, a custom property, or a url( that never
// closes) is redacted as free text, to the next whitespace. Minified CSS has
// no whitespace after a url(), so the free-text mask alone removed every rule
// after one. A bare payload needs at least one character: with an empty one,
// the whitespace before and after it could split a long run of spaces in
// quadratically many ways.
const CSS_URL_RE = new RegExp(`${/(\burl\(\s*)(?:"((?:[^"\\]|\\[\s\S])*)"|'((?:[^'\\]|\\[\s\S])*)'|((?:[^\s"'()\\]|\\[\s\S])+))(\s*\))/.source}|${URL_TOKEN_RE.source}`, "gi");
const CSS_URL_SCHEME_RE = /^[a-z][a-z0-9+.-]{0,31}:\/\//i;

// A url() payload that is an absolute URL is redacted as one URL, so a space
// or an escaped quote in its query cannot end the mask early. Any other
// payload (a relative URL, a data: mask) only has the URLs inside it redacted.
function redactCssUrlPayload(payload) {
  if (CSS_URL_SCHEME_RE.test(payload)) return redactUrl(payload);
  return payload.replace(URL_TOKEN_RE, (m) => redactUrl(m));
}

function scrubCssText(text, maxLen) {
  if (typeof text !== "string") return text;
  let scrubbed = text.replace(CSS_DATA_URI_RE, (m, doubleQuoted, singleQuoted, bare) => {
    if (doubleQuoted !== undefined) return `url("data:[${doubleQuoted.length} chars]")`;
    if (singleQuoted !== undefined) return `url('data:[${singleQuoted.length} chars]')`;
    if (bare !== undefined) return `url(data:[${bare.length} chars])`;
    return `data:[${m.length} chars]`;
  });
  scrubbed = scrubbed.replace(CSS_URL_RE, (m, open, doubleQuoted, singleQuoted, bare, close) => {
    if (open === undefined) return redactUrl(m);
    if (doubleQuoted !== undefined) return `${open}"${redactCssUrlPayload(doubleQuoted)}"${close}`;
    if (singleQuoted !== undefined) return `${open}'${redactCssUrlPayload(singleQuoted)}'${close}`;
    return `${open}${redactCssUrlPayload(bare)}${close}`;
  });
  return clipTo(scrubbed, maxLen);
}

function clipTo(s, max) {
  return typeof max === "number" && s.length > max ? `${s.slice(0, max)}…` : s;
}

// Replaces every URL-like token (and every data: URI) in free text with its
// redacted form, then (optionally) clips the result. Used for error/outcome
// text, the generic fallback's string values, and every rrweb attribute
// value the walker sees — anywhere a secret could ride in as a
// query string, fragment or data: payload without the text itself being a
// dedicated URL field.
function scrubUrls(text, maxLen) {
  if (typeof text !== "string") return text;
  let scrubbed = text.replace(DATA_URI_RE, (m) => `data:[${m.length} chars]`);
  scrubbed = scrubbed.replace(URL_TOKEN_RE, (m) => redactUrl(m));
  return clipTo(scrubbed, maxLen);
}

// A data: URL's whole payload sits in what the try block below otherwise
// treats as non-secret path/host structure (right for a directory-style URL:
// only its query/fragment are secret-bearing; wrong for a data: one, whose
// payload — a recovery code, a 2FA QR-code image — IS the secret). Masked the
// same way navigate's own data: rule does. The parser also reads some inputs
// that do not start with "data:" as data: URLs (a tab inside the scheme, a
// leading control character), so its protocol is checked as well.
function redactUrl(url) {
  if (typeof url === "string" && /^\s*data:/i.test(url)) return `data:[${url.length} chars]`;
  try {
    const u = new URL(url);
    if (u.protocol === "data:") return `data:[${url.length} chars]`;
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

// A run of `key` calls, one bare printable character at a time, is how the
// `key` action can type real text while bypassing `type`'s own redaction (see
// background.js's charDefinition/keyDefinition). Every named key (Enter, Tab,
// F5, ...) is at least 2 characters, so a key part that is exactly one
// character is a character press, never a name. Shift held with it still types
// that character (a capital letter, or a shifted symbol), so shift is the one
// modifier that keeps a token a typed key. Any other modifier (ctrl+a,
// cmd+shift+t) makes it a shortcut, which stays as-is. Parts are read the way
// background.js's parseKeyCombo reads them: trimmed, with modifier names in
// any case.
function isBareKeyToken(token) {
  const parts = token.split("+");
  const key = parts.pop().trim();
  return [...key].length === 1 && parts.every((modifier) => modifier.trim().toLowerCase() === "shift");
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
      // A malformed region (not an array) must not throw — the action is
      // still recorded, just without the region detail.
      if (Array.isArray(args.region)) s += ` region [${args.region.join(", ")}]`;
      break;
  }
  return s;
}

// Mirrors the navigate handler's own scheme-less normalization (background.js)
// so the audit summary reflects the URL it will actually navigate to, not a
// literal reading of whatever the caller passed. Named distinctly from
// background.js's own like-named helper: redact.js is a classic script sharing
// the worker's global scope with everything else importScripts loads, and
// background.js declares its own `normalizeNavigateUrl(input, ownExtensionId)`
// — importScripts runs after background.js's own declarations are hoisted, so
// an identically-named function here would silently replace it and break
// navigate.
function auditNavigateTarget(url) {
  if (/^https?:\/\//i.test(url) || url.startsWith("about:") || url.startsWith("chrome:") || url.startsWith("brave:")) return url;
  return `https://${url.replace(/^[a-z]{1,5}:\/+/i, "")}`;
}

function navigateSummary(args) {
  const { url } = args;
  if (url === "back" || url === "forward") return url;
  // Match case-insensitively and after trimming ("DATA:...", " data:...").
  if (typeof url === "string" && /^\s*data:/i.test(url)) return `data:[${url.length} chars]`;
  return redactUrl(auditNavigateTarget(url));
}

function formInputSummary(args) {
  const { ref, value } = args;
  if (typeof value === "boolean") return `${ref} checked=${value}`;
  if (typeof value === "number") return `${ref} value [number]`;
  return `${ref} value [${String(value).length} chars]`;
}

// Replaces the contents of every '...', "..." and `...` literal with
// [N chars], while leaving comments and surrounding code untouched. A template
// literal's whole span (backtick to its own matching backtick) is masked as
// one unit, including any nested ${...} substitutions — those are walked (via
// skipTemplate below), not masked separately, purely to find the TRUE matching
// backtick without being fooled by a string, a comment, or a further nested
// template inside the substitution. Comments (// and /* */) are skipped as
// comments, not scanned for quotes, so a quote inside one no longer
// desynchronizes the scanner onto a later, real secret. A // comment ends at
// any JavaScript line terminator: LF, CR, U+2028 or
// U+2029, not only at LF, or the code after a CR would pass as comment text.
//
// Earlier drafts also tried to guess whether a "/" opened a regex literal or
// was a division operator, by the token before it. That heuristic itself
// leaked real secrets on adversarial inputs, most often through a postfix
// "++"/"--" right before a "/" (e.g. `done++ / total`), which was misjudged
// as a regex opener and swallowed everything up to a LATER, unrelated "/"
// inside a real string, un-masking it.
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
// The cap counts template frames only. A level pushes
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
      // Never guess whether this is a regex or a
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

// upload_image can target a ref or a coordinate; show whichever was given
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

// --- rrweb event redaction, run in the worker (Audit.onRecorderEvents)
// before a recorder batch is stored, so a recorder in any document cannot pass
// through a raw secret regardless of what it actually sent. ---

// Attributes that carry a URL, wherever they appear (any tag) — checked by
// name only, since the attribute name alone identifies it as URL-bearing.
const URL_ATTRS = ["href", "src", "action", "formaction", "poster"];

// "url descriptor, url descriptor, ..." — redact each URL, keep its descriptor
// (a width like "480w" or a density like "2x") untouched.
//
// A data: URL's payload holds a comma, and can hold a whole URL of its own
// ("data:text/plain,https://x.test/SECRET 1x"), so splitting such a value at
// its commas would keep part of the payload as if it were a URL. A value that
// holds "data:" is read the way the HTML srcset parser reads it instead: a
// candidate's URL runs to the next whitespace, commas included, and its
// descriptors run to the next comma. A data: URL is masked whole. Its
// descriptors stay only when they are real descriptors. Anything else after
// it may be more of the payload, so the mask then runs to the end of the
// value (fail closed).
const SRCSET_DESCRIPTORS_RE = /^\d+(?:\.\d+)?[wxh](?:\s+\d+(?:\.\d+)?[wxh])*$/i;

function redactSrcset(value) {
  if (!/data:/i.test(value)) {
    return value.split(",").map((part) => {
      const trimmed = part.trim();
      const spaceIdx = trimmed.indexOf(" ");
      if (spaceIdx === -1) return redactUrl(trimmed);
      return redactUrl(trimmed.slice(0, spaceIdx)) + trimmed.slice(spaceIdx);
    }).join(", ");
  }
  const isSpace = (ch) => ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "\f";
  const out = [];
  let i = 0;
  while (i < value.length) {
    while (i < value.length && (isSpace(value[i]) || value[i] === ",")) i++;
    if (i >= value.length) break;
    const start = i;
    while (i < value.length && !isSpace(value[i])) i++;
    let end = i;
    let descriptors = "";
    if (value[end - 1] === ",") {
      while (end > start && value[end - 1] === ",") end--; // a URL's trailing commas end its candidate
    } else {
      const comma = value.indexOf(",", i);
      const stop = comma === -1 ? value.length : comma;
      descriptors = value.slice(i, stop).trim();
      i = stop;
    }
    const redacted = redactUrl(value.slice(start, end));
    if (redacted.startsWith("data:[") && descriptors !== "" && !SRCSET_DESCRIPTORS_RE.test(descriptors)) {
      out.push(`data:[${value.length - start} chars]`);
      break;
    }
    out.push(descriptors ? `${redacted} ${descriptors}` : redacted);
  }
  return out.join(", ");
}

// Masks input/textarea `value` attributes with `*` of the same length,
// when `shouldMaskValue` is true. In a full snapshot or an `adds` entry the
// tag is always directly known, so the caller passes it positively (input or
// textarea only — an <option>'s value is page content, not a typed secret).
// For an attribute mutation, the caller instead fails closed: an id the
// walker does not recognize at all — which happens for real after a worker
// restart (the tag map lives only in memory) or any batch dropped before
// reaching the walker — is masked too, accepting that a button's or meter's
// value gets masked as a rare, acceptable cost. A tag *positively* known to be
// something else stays untouched either way. Every other string attribute is
// also run through scrubUrls, since a URL can ride in as free text on an
// attribute that isn't one of the dedicated URL_ATTRS (e.g. a
// <meta property="og:url" content="...?token=...">).
function redactAttributes(shouldMaskValue, attributes) {
  if (!attributes || typeof attributes !== "object") return;
  if (typeof attributes.value === "string") {
    // A value that is kept rather than masked (an <option>'s or a <button>'s —
    // page content, not a typed secret) can still carry a URL's query as its
    // own text (e.g. an <option value="https://...?token=...">) — scrub that
    // even though the value itself isn't asterisk-masked.
    if (shouldMaskValue) attributes.value = "*".repeat(attributes.value.length);
    else attributes.value = scrubUrls(attributes.value);
  }
  for (const attr of URL_ATTRS) {
    if (typeof attributes[attr] === "string") attributes[attr] = redactUrl(attributes[attr]);
  }
  if (typeof attributes.srcset === "string") attributes.srcset = redactSrcset(attributes.srcset);
  // A signed image URL's query can ride in a style value in any shape rrweb
  // sends. A style is a string in a snapshot, and in a
  // mutation whose diff would be longer than the whole value (the usual case
  // for el.style.x = ... on an element without an inline style). Otherwise it
  // is a diff object, CSS property -> new value, where a value is a string, a
  // [value, priority] array for an !important one, or false for a removed
  // property.
  if (typeof attributes.style === "string") {
    attributes.style = scrubCssText(attributes.style);
  } else if (attributes.style && typeof attributes.style === "object") {
    for (const [prop, value] of Object.entries(attributes.style)) {
      if (typeof value === "string") {
        attributes.style[prop] = scrubCssText(value);
      } else if (Array.isArray(value)) {
        for (let k = 0; k < value.length; k++) {
          if (typeof value[k] === "string") value[k] = scrubCssText(value[k]);
        }
      }
    }
  }
  // rrweb carries a <style> or an inlined <link rel=stylesheet>'s whole text
  // as _cssText — CSS text, not free text, so it gets the same data: handling
  // as style above, not scrubUrls' plain mask-to-the-end.
  if (typeof attributes._cssText === "string") attributes._cssText = scrubCssText(attributes._cssText);
  for (const [name, value] of Object.entries(attributes)) {
    if (name === "value" || name === "srcset" || name === "style" || name === "_cssText" || URL_ATTRS.includes(name)) continue; // already handled above
    if (typeof value === "string") attributes[name] = scrubUrls(value);
  }
}

function isMaskableValueTag(tagName) {
  return tagName === "input" || tagName === "textarea";
}

// knownTags values for text nodes. Tag names never start with "#".
const AUDIT_STYLE_TEXT = "#style-text";
const AUDIT_PLAIN_TEXT = "#text";

// Walks a snapshot (or newly-added) node and its descendants: records each
// node's rrweb id into `knownTags` (so a later, separate mutation event on the
// same id can be classified) and redacts it in place. An element maps to its
// lowercase tagName. A text node maps to AUDIT_STYLE_TEXT when its parent is
// a <style> element, or when the walker does not know its parent (fail
// closed), and to AUDIT_PLAIN_TEXT otherwise. A style text node holds CSS, so
// its text goes through the CSS scrubber. `parentTag` is the parent's
// knownTags value: undefined for a parent the walker never saw (an `adds`
// entry after a worker restart, or after a dropped batch), and "#document"
// under a document node.
function walkSnapshotNode(node, knownTags, parentTag) {
  if (!node || typeof node !== "object") return;
  let childParentTag = "#document";
  if (node.type === 2 /* Element */ && typeof node.tagName === "string") {
    const tagName = node.tagName.toLowerCase();
    if (node.id != null) knownTags.set(node.id, tagName);
    redactAttributes(isMaskableValueTag(tagName), node.attributes);
    childParentTag = tagName;
  } else if (node.type === 3 /* Text */) {
    const styleText = parentTag === undefined || parentTag === "style";
    if (node.id != null) knownTags.set(node.id, styleText ? AUDIT_STYLE_TEXT : AUDIT_PLAIN_TEXT);
    if (styleText && typeof node.textContent === "string") node.textContent = scrubCssText(node.textContent);
  }
  if (Array.isArray(node.childNodes)) {
    for (const child of node.childNodes) walkSnapshotNode(child, knownTags, childParentTag);
  }
}

// Redacts an rrweb event batch in place before it is relayed or stored:
// - Meta (type 4): data.href through redactUrl. A Meta event always starts a
//   fresh document, the same one its own FullSnapshot is about to describe,
//   so `knownTags` is cleared here too — not only on the
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
//   walkSnapshotNode, under its parent's knownTags value. Each `texts` entry
//   (a text node's new text, the way a script rewrites a <style>) goes through
//   the CSS scrubber unless its id is known to be plain text, so a style text
//   node and an id the walker has never seen both fail closed. Each
//   `attributes` entry via knownTags — masking unless the id is *positively*
//   known to be something other than input/textarea, so an id the walker has
//   never seen fails closed instead of passing a raw value through. A node's
//   defining snapshot/add can land in an earlier batch than a later mutation
//   on it — the caller keeps `knownTags` across calls for that reason.
// - IncrementalSnapshot AdoptedStyleSheet (type 3, source 15): the rules of
//   each stylesheet the page adopted, sent with every full snapshot, through
//   the CSS scrubber.
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
      for (const add of event.data.adds || []) walkSnapshotNode(add.node, knownTags, knownTags.get(add.parentId));
      for (const text of event.data.texts || []) {
        if (text && typeof text.value === "string" && knownTags.get(text.id) !== AUDIT_PLAIN_TEXT) text.value = scrubCssText(text.value);
      }
      for (const mutation of event.data.attributes || []) {
        const tagName = knownTags.get(mutation.id);
        redactAttributes(tagName === undefined || isMaskableValueTag(tagName), mutation.attributes);
      }
    } else if (event.type === 3 && event.data && event.data.source === 15) {
      for (const sheet of event.data.styles || []) {
        for (const rule of (sheet && sheet.rules) || []) {
          if (rule && typeof rule.rule === "string") rule.rule = scrubCssText(rule.rule);
        }
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
