// JSON cache for normalized Figma data. Lives OUTSIDE the project/git tree by
// default (designs are not source). Tracks lastModified for freshness checks.

const fs = require("fs");
const os = require("os");
const path = require("path");

function cacheRoot() {
  if (process.env.FIGMA_CACHE_DIR) return process.env.FIGMA_CACHE_DIR;
  return path.join(os.homedir(), ".cache", "figma-connector");
}

function dirFor(fileKey) {
  const d = path.join(cacheRoot(), fileKey);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function fileFor(fileKey, name) {
  return path.join(dirFor(fileKey), name);
}

function writeJson(fileKey, name, obj) {
  const p = fileFor(fileKey, name);
  fs.writeFileSync(p, JSON.stringify(obj, null, 2));
  return p;
}

function readJson(fileKey, name) {
  const p = fileFor(fileKey, name);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (_) {
    return null;
  }
}

// Read/write the small freshness record: { lastModified, version, cachedAt }.
function readStamp(fileKey) {
  return readJson(fileKey, "_stamp.json");
}

function writeStamp(fileKey, { lastModified, version }) {
  return writeJson(fileKey, "_stamp.json", {
    lastModified: lastModified || null,
    version: version || null,
    cachedAt: new Date().toISOString(),
  });
}

// True when the live design is newer than what we cached.
function isStale(fileKey, liveLastModified) {
  const stamp = readStamp(fileKey);
  if (!stamp || !stamp.lastModified) return true;
  if (!liveLastModified) return false;
  return new Date(liveLastModified).getTime() > new Date(stamp.lastModified).getTime();
}

module.exports = {
  cacheRoot,
  dirFor,
  fileFor,
  writeJson,
  readJson,
  readStamp,
  writeStamp,
  isStale,
};
