// Enforces the file_upload folder allowlist and combined-size limit in the
// host, before a request reaches the browser extension.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const MAX_TOTAL_BYTES = 10 * 1024 * 1024;

function expandHome(entry, home) {
  return entry.startsWith("~/") ? path.join(home, entry.slice(2)) : entry;
}

// Reads fileUploadAllowedDirs from config.json.
// - Missing file, or valid JSON without the key: { dirs: null, error: null } (defaults apply).
// - Unreadable file, invalid JSON, or the key present but not an array:
//   { dirs: null, error: "<reason>" } (caller fails closed instead of falling back).
function readConfiguredDirs(home) {
  const configPath = path.join(home, ".config", "open-claude-in-chrome", "config.json");

  let raw;
  try {
    raw = fs.readFileSync(configPath, "utf-8");
  } catch (err) {
    if (err.code === "ENOENT") return { dirs: null, error: null };
    return { dirs: null, error: "config file could not be read" };
  }

  let config;
  try {
    config = JSON.parse(raw);
  } catch {
    return { dirs: null, error: "config file is not valid JSON" };
  }

  const value = config?.fileUploadAllowedDirs;
  if (value === undefined) return { dirs: null, error: null };
  if (!Array.isArray(value)) return { dirs: null, error: "fileUploadAllowedDirs must be an array" };
  return { dirs: value, error: null };
}

// Resolves each candidate to a realpath, dropping ones that don't exist or
// aren't directories. Also keeps each survivor's pre-realpath (but
// home-expanded) form: when HOME itself sits behind a symlink (e.g. /tmp ->
// /private/tmp on macOS), an upload path built from that same unresolved
// HOME shares the lexical form's prefix but not the realpath's.
function resolveDirs(candidates) {
  const lexicalDirs = [];
  const allowedDirs = [];
  for (const dir of candidates) {
    try {
      const real = fs.realpathSync(dir);
      if (!fs.statSync(real).isDirectory()) continue;
      lexicalDirs.push(path.resolve(dir));
      allowedDirs.push(real);
    } catch {
      // missing or inaccessible: skip
    }
  }
  return { lexicalDirs, allowedDirs };
}

export function loadUploadPolicy({ home = os.homedir(), warn = (m) => process.stderr.write(m) } = {}) {
  // A non-absolute HOME would make the config path relative to the server's
  // working directory instead of the user's home: fail closed instead.
  if (!path.isAbsolute(home)) return { allowedDirs: [], lexicalDirs: [], configError: null };

  const { dirs: configured, error: configError } = readConfiguredDirs(home);
  if (configError) {
    warn(`open-claude-in-chrome: ${configError} in ~/.config/open-claude-in-chrome/config.json; no upload folder is allowed until it is fixed\n`);
    return { allowedDirs: [], lexicalDirs: [], configError };
  }

  const rawDirs = configured !== null
    ? configured
    : [path.join(home, "Downloads"), path.join(home, "Desktop")];

  const candidates = [];
  for (const entry of rawDirs) {
    if (typeof entry !== "string") continue;
    const expanded = expandHome(entry, home);
    if (!path.isAbsolute(expanded)) {
      warn(`open-claude-in-chrome: ignoring relative fileUploadAllowedDirs entry "${entry}"\n`);
      continue;
    }
    candidates.push(expanded);
  }

  const { lexicalDirs, allowedDirs } = resolveDirs(candidates);
  return { allowedDirs, lexicalDirs, configError: null };
}

function inAnyDir(candidate, dirs) {
  return dirs.some((dir) => candidate === dir || candidate.startsWith(dir + path.sep));
}

function allowedFoldersSuffix(allowedDirs) {
  const configSentence = "Change them with fileUploadAllowedDirs in ~/.config/open-claude-in-chrome/config.json.";
  return allowedDirs.length === 0
    ? ` No upload folder is allowed. ${configSentence}`
    : ` Allowed folders: ${allowedDirs.join(", ")}. ${configSentence}`;
}

export function checkUploadPaths(paths, policy) {
  if (policy.configError) {
    return {
      ok: false,
      error: `Upload policy config is invalid (${policy.configError}), so no folder is allowed. Fix ~/.config/open-claude-in-chrome/config.json.`,
    };
  }

  const suffix = allowedFoldersSuffix(policy.allowedDirs);
  if (!Array.isArray(paths)) {
    return { ok: false, error: `paths must be an array of strings.${suffix}` };
  }

  const preCheckDirs = [...policy.lexicalDirs, ...policy.allowedDirs];
  const resolved = [];
  let totalBytes = 0;

  for (const p of paths) {
    if (typeof p !== "string" || !path.isAbsolute(p)) {
      return { ok: false, error: `Path must be absolute: ${p}.${suffix}` };
    }

    // Containment first, lexically, before any filesystem call: a path
    // outside the allowlist must never reveal whether it exists, its type,
    // or where a symlink points (no existence oracle outside the allowlist).
    if (!inAnyDir(path.resolve(p), preCheckDirs)) {
      return { ok: false, error: `Not in an allowed upload folder: ${p}.${suffix}` };
    }

    let real;
    try {
      real = fs.realpathSync(p);
    } catch (err) {
      if (err.code === "ENOENT") return { ok: false, error: `File not found: ${p}.${suffix}` };
      return { ok: false, error: `Cannot access: ${p} (${err.code}).${suffix}` };
    }

    // Re-check containment of the realpath: a symlink inside an allowed
    // folder can still point outside it. Report the path as given, never
    // the target it escapes to.
    if (!inAnyDir(real, policy.allowedDirs)) {
      return { ok: false, error: `Not in an allowed upload folder: ${p}.${suffix}` };
    }

    let stat;
    try {
      stat = fs.statSync(real);
    } catch (err) {
      if (err.code === "ENOENT") return { ok: false, error: `File not found: ${real}.${suffix}` };
      return { ok: false, error: `Cannot access: ${real} (${err.code}).${suffix}` };
    }
    if (!stat.isFile()) {
      return { ok: false, error: `Not a regular file: ${real}.${suffix}` };
    }

    resolved.push(real);
    totalBytes += stat.size;
  }

  if (totalBytes > MAX_TOTAL_BYTES) {
    const mb = (totalBytes / (1024 * 1024)).toFixed(1);
    return { ok: false, error: `Combined size ${mb} MB exceeds the 10 MB limit.${suffix}` };
  }

  return { ok: true, resolved };
}
