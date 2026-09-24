// Turns a tool call's raw args into a short summary safe for the audit log: never
// typed text, form values, password fields, or a URL's query string/fragment.
// Classic script, loaded via importScripts (background.js) or a vm context (tests).

const AUDIT_STRING_CLIP = 100;
const AUDIT_SUMMARY_CLIP = 300;
const AUDIT_JS_CODE_CLIP = 500;

// A scheme + "://" + a run of non-whitespace/non-quote/non-bracket characters —
// good enough to find a URL embedded in a free-text Chrome error message.
const URL_TOKEN_RE = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>)]+/gi;

function clipTo(s, max) {
  return typeof max === "number" && s.length > max ? `${s.slice(0, max)}…` : s;
}

// Replaces every URL-like token in free text with its redactUrl() form, then
// (optionally) clips the result. Used for error/outcome text (I1) and for the
// generic fallback's string values (M9) — anywhere a secret could ride in as a
// query string or fragment without the text itself being a `navigate` call.
function scrubUrls(text, maxLen) {
  if (typeof text !== "string") return text;
  const scrubbed = text.replace(URL_TOKEN_RE, (m) => redactUrl(m));
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

// I5: replaces the contents of every '...', "..." and `...` literal (including
// a template literal's ${} parts, which are not parsed out separately — the
// whole backtick span is masked as one unit) with [N chars], honoring
// backslash escapes so an escaped quote never ends a literal early. Comments
// and surrounding code are left alone. This is a lexical scan, not a full JS
// parser: a template literal nested inside another one's ${} is not specially
// balanced, which is an acceptable gap for a best-effort audit redaction.
function maskJsStringLiterals(code) {
  let out = "";
  let i = 0;
  const n = code.length;
  while (i < n) {
    const ch = code[i];
    if (ch === "'" || ch === '"' || ch === "`") {
      const quote = ch;
      let j = i + 1;
      while (j < n && code[j] !== quote) {
        j += code[j] === "\\" && j + 1 < n ? 2 : 1;
      }
      const contentLen = j - (i + 1);
      const closed = j < n;
      out += quote + `[${contentLen} chars]` + (closed ? quote : "");
      i = closed ? j + 1 : j;
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
