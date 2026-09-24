// Turns a tool call's raw args into a short summary safe for the audit log: never
// typed text, form values, password fields, or a URL's query string/fragment.
// Classic script, loaded via importScripts (background.js) or a vm context (tests).

const AUDIT_STRING_CLIP = 100;
const AUDIT_SUMMARY_CLIP = 300;
const AUDIT_JS_CODE_CLIP = 500;

function redactUrl(url) {
  try {
    const u = new URL(url);
    let s = `${u.protocol}//${u.host}${u.pathname}`;
    if (u.search) s += "?…";
    if (u.hash) s += "#…";
    return s;
  } catch {
    return "[unparseable url]";
  }
}

function clipDeep(value, max) {
  if (typeof value === "string") return value.length > max ? `${value.slice(0, max)}…` : value;
  if (Array.isArray(value)) return value.map((v) => clipDeep(v, max));
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = clipDeep(v, max);
    return out;
  }
  return value;
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
      s += ` ${args.text || ""}`;
      break;
    case "scroll":
      s += ` ${args.scroll_direction || "down"} ${args.scroll_amount ?? 3}`;
      break;
    case "zoom":
      if (args.region) s += ` region [${args.region.join(", ")}]`;
      break;
  }
  return s;
}

function navigateSummary(args) {
  const { url } = args;
  if (url === "back" || url === "forward") return url;
  if (typeof url === "string" && url.startsWith("data:")) return `data:[${url.length} chars]`;
  return redactUrl(url);
}

function formInputSummary(args) {
  const { ref, value } = args;
  if (typeof value === "boolean") return `${ref} checked=${value}`;
  if (typeof value === "number") return `${ref} value [number]`;
  return `${ref} value [${String(value).length} chars]`;
}

function javascriptSummary(args) {
  const code = args.text || "";
  if (code.length <= AUDIT_JS_CODE_CLIP) return code;
  return `${code.slice(0, AUDIT_JS_CODE_CLIP)} … (+${code.length - AUDIT_JS_CODE_CLIP} chars)`;
}

function fileUploadSummary(args) {
  const paths = Array.isArray(args.paths) ? args.paths : [];
  return `${args.ref} paths: ${paths.join(", ")}`;
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
    case "upload_image": return `imageId ${args.imageId} ${args.ref}`;
    case "browser_batch": return browserBatchSummary(args);
    default: return genericSummary(args);
  }
}
