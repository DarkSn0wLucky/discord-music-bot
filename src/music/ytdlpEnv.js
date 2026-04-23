const fs = require("fs");
const path = require("path");
const { YTDLP_RUNTIME_PATH, YTDLP_TMP_DIR } = require("../config");

const TMP_CLEANUP_INTERVAL_MS = 60_000;
const TMP_STALE_TTL_MS = 10 * 60_000;
const TMP_MAX_MEI_DIRS = 8;

let lastCleanupAt = 0;

function resolveYtDlpTmpDir() {
  const configured = String(YTDLP_TMP_DIR || "").trim();
  if (!configured) {
    return path.resolve(process.cwd(), ".cache", "yt-dlp-tmp");
  }

  return path.isAbsolute(configured) ? configured : path.resolve(process.cwd(), configured);
}

function ensureYtDlpTmpDir() {
  const resolved = resolveYtDlpTmpDir();
  try {
    fs.mkdirSync(resolved, { recursive: true });
    return resolved;
  } catch (error) {
    console.warn(`[yt-dlp tmp] cannot create temp dir at ${resolved}: ${error.message}`);
    return "/tmp";
  }
}

function safeRemoveDirectory(targetPath) {
  try {
    fs.rmSync(targetPath, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

function cleanupYtDlpTempArtifacts(tmpDir, { force = false } = {}) {
  const now = Date.now();
  if (!force && now - lastCleanupAt < TMP_CLEANUP_INTERVAL_MS) {
    return;
  }
  lastCleanupAt = now;

  let entries = [];
  try {
    entries = fs.readdirSync(tmpDir, { withFileTypes: true });
  } catch {
    return;
  }

  const candidates = entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("_MEI"))
    .map((entry) => {
      const fullPath = path.join(tmpDir, entry.name);
      try {
        const stats = fs.statSync(fullPath);
        return { fullPath, mtimeMs: Number(stats.mtimeMs) || 0 };
      } catch {
        return null;
      }
    })
    .filter(Boolean);

  for (const candidate of candidates) {
    if (now - candidate.mtimeMs >= TMP_STALE_TTL_MS) {
      safeRemoveDirectory(candidate.fullPath);
    }
  }

  if (candidates.length <= TMP_MAX_MEI_DIRS) {
    return;
  }

  const sortedByAge = [...candidates].sort((left, right) => left.mtimeMs - right.mtimeMs);
  const excessive = sortedByAge.slice(0, Math.max(0, sortedByAge.length - TMP_MAX_MEI_DIRS));
  for (const candidate of excessive) {
    safeRemoveDirectory(candidate.fullPath);
  }
}

function buildYtDlpEnv(baseEnv = process.env) {
  const env = { ...baseEnv };
  const tmpDir = ensureYtDlpTmpDir();
  cleanupYtDlpTempArtifacts(tmpDir);

  env.TMPDIR = tmpDir;
  env.TMP = tmpDir;
  env.TEMP = tmpDir;

  const runtimePath = String(YTDLP_RUNTIME_PATH || "").trim();
  if (runtimePath) {
    env.PATH = `${runtimePath}${path.delimiter}${env.PATH || ""}`;
  }

  return env;
}

module.exports = {
  buildYtDlpEnv,
  cleanupYtDlpTempArtifacts,
  ensureYtDlpTmpDir,
};
