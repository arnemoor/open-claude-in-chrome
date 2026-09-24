// Enforces the file_upload folder allowlist and combined-size limit in the
// host, before a request reaches the browser extension.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const MAX_TOTAL_BYTES = 10 * 1024 * 1024;

function expandHome(entry, home) {
  return entry.startsWith("~/") ? path.join(home, entry.slice(2)) : entry;
}

// Reads fileUploadAllowedDirs from config.json. Returns null (defaults apply)
// when the config is missing, unreadable, invalid JSON, or lacks the key.
function readConfiguredDirs(home) {
  try {
    const configPath = path.join(home, ".config", "open-claude-in-chrome", "config.json");
    const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    if (Array.isArray(config.fileUploadAllowedDirs)) return config.fileUploadAllowedDirs;
  } catch {
    // missing or invalid config: fall back to defaults
  }
  return null;
}

// Resolves each candidate to a realpath, dropping ones that don't exist or
// aren't directories.
function realDirs(candidates) {
  const out = [];
  for (const dir of candidates) {
    try {
      const real = fs.realpathSync(dir);
      if (fs.statSync(real).isDirectory()) out.push(real);
    } catch {
      // missing or inaccessible: skip
    }
  }
  return out;
}

export function loadUploadPolicy({ home = os.homedir(), tmpDirs = [os.tmpdir(), "/tmp"] } = {}) {
  const configured = readConfiguredDirs(home);
  const rawDirs = configured !== null
    ? configured
    : [path.join(home, "Downloads"), path.join(home, "Desktop"), ...tmpDirs];

  const candidates = [];
  for (const entry of rawDirs) {
    if (typeof entry !== "string") continue;
    const expanded = expandHome(entry, home);
    if (!path.isAbsolute(expanded)) {
      process.stderr.write(`open-claude-in-chrome: ignoring relative fileUploadAllowedDirs entry "${entry}"\n`);
      continue;
    }
    candidates.push(expanded);
  }

  return { allowedDirs: realDirs(candidates) };
}

export function checkUploadPaths(paths, policy) {
  const suffix = ` Allowed folders: ${policy.allowedDirs.join(", ")}. Change them with fileUploadAllowedDirs in ~/.config/open-claude-in-chrome/config.json.`;
  const resolved = [];
  let totalBytes = 0;

  for (const p of paths) {
    if (typeof p !== "string" || !path.isAbsolute(p)) {
      return { ok: false, error: `Path must be absolute: ${p}.${suffix}` };
    }

    let real;
    try {
      real = fs.realpathSync(p);
    } catch {
      return { ok: false, error: `File not found: ${p}.${suffix}` };
    }

    const stat = fs.statSync(real);
    if (!stat.isFile()) {
      return { ok: false, error: `Not a regular file: ${real}.${suffix}` };
    }

    const inAllowedDir = policy.allowedDirs.some((dir) => real === dir || real.startsWith(dir + path.sep));
    if (!inAllowedDir) {
      return { ok: false, error: `Not in an allowed upload folder: ${real}.${suffix}` };
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
