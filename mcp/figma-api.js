// Thin wrapper around the Figma REST API. Zero dependencies — uses a small
// https-based HTTP helper so no global fetch is required.

const fs = require("fs");
const os = require("os");
const path = require("path");
const httpc = require("./http");

const BASE = "https://api.figma.com/v1";

let _cachedToken;

// Resolve the token from (in order): FIGMA_TOKEN env, a file named by
// FIGMA_TOKEN_FILE, or ~/.config/figma-connector/token. The file fallback
// means the token survives plugin updates and needs no bundle editing.
function token() {
  if (_cachedToken) return _cachedToken;

  const fromEnv = (process.env.FIGMA_TOKEN || "").trim();
  // Ignore an unexpanded "${FIGMA_TOKEN}" placeholder: some hosts pass the
  // literal string through when they don't substitute env vars. Treat it as
  // unset so the token-file fallback below can take over.
  const isPlaceholder = /^\$\{.*\}$/.test(fromEnv);
  if (fromEnv && !isPlaceholder) return (_cachedToken = fromEnv);

  const candidates = [
    process.env.FIGMA_TOKEN_FILE,
    path.join(os.homedir(), ".config", "figma-connector", "token"),
    path.join(os.homedir(), ".figma-connector-token"),
  ].filter(Boolean);

  for (const p of candidates) {
    try {
      const v = fs.readFileSync(p, "utf8").trim();
      if (v) return (_cachedToken = v);
    } catch (_) {
      /* not present, try next */
    }
  }

  throw new Error(
    "FIGMA_TOKEN is not set. Either set the FIGMA_TOKEN env var in the connector config, " +
      "or save your token to ~/.config/figma-connector/token"
  );
}

// Accepts a full Figma URL or a bare file key and returns { fileKey, nodeId }.
// Supports /file/, /design/, /proto/ URL shapes. Converts node-id "1-2" -> "1:2".
function parseFileRef(input) {
  if (!input) throw new Error("Provide a Figma file URL or file key.");
  const str = String(input).trim();

  // Bare key (no slashes / not a URL)
  if (!str.includes("/") && !str.includes("figma.com")) {
    return { fileKey: str, nodeId: null };
  }

  let fileKey = null;
  let nodeId = null;
  const m = str.match(/figma\.com\/(?:file|design|proto)\/([A-Za-z0-9]+)/);
  if (m) fileKey = m[1];

  try {
    const u = new URL(str);
    const raw = u.searchParams.get("node-id");
    if (raw) nodeId = raw.replace(/-/g, ":");
  } catch (_) {
    /* not a URL, ignore */
  }

  if (!fileKey) {
    const parts = str.split("/").filter(Boolean);
    fileKey = parts[parts.length - 1];
  }
  if (!fileKey) throw new Error(`Could not extract a file key from: ${input}`);
  return { fileKey, nodeId };
}

function normalizeNodeId(id) {
  return String(id).replace(/-/g, ":");
}

async function call(path) {
  const url = `${BASE}${path}`;
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    let res;
    try {
      res = await httpc.getJson(url, { headers: { "X-Figma-Token": token() } });
    } catch (e) {
      lastErr = e;
      await sleep(400 * (attempt + 1));
      continue;
    }
    if (res.status === 429 || res.status >= 500) {
      lastErr = new Error(`Figma API ${res.status} on ${path}`);
      await sleep(800 * (attempt + 1));
      continue;
    }
    if (!res.ok) {
      throw new Error(`Figma API ${res.status} on ${path}: ${(res.text || "").slice(0, 300)}`);
    }
    return res.json;
  }
  throw lastErr || new Error(`Figma API request failed: ${path}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- Endpoints ---

// Full file document. depth limits tree traversal (smaller payloads).
async function getFile(fileKey, { depth } = {}) {
  const q = depth ? `?depth=${depth}` : "";
  return call(`/files/${fileKey}${q}`);
}

// Lightweight metadata: name + lastModified + version (cheap freshness check).
async function getFileMeta(fileKey) {
  return call(`/files/${fileKey}?depth=1`);
}

// Specific nodes by id.
async function getNodes(fileKey, ids) {
  const idParam = ids.map(normalizeNodeId).join(",");
  return call(`/files/${fileKey}/nodes?ids=${encodeURIComponent(idParam)}`);
}

// Published style metadata (color/text/effect/grid style names + keys).
async function getStyles(fileKey) {
  return call(`/files/${fileKey}/styles`);
}

// Local variables + collections. Enterprise-only endpoint; caller handles 403.
async function getLocalVariables(fileKey) {
  return call(`/files/${fileKey}/variables/local`);
}

// Render nodes to image URLs. format: svg | png | jpg | pdf.
async function getImageRenders(fileKey, ids, { format = "svg", scale = 1 } = {}) {
  const idParam = ids.map(normalizeNodeId).join(",");
  const q = `?ids=${encodeURIComponent(idParam)}&format=${format}&scale=${scale}`;
  const data = await call(`/images/${fileKey}${q}`);
  if (data.err) throw new Error(`Figma image render error: ${data.err}`);
  return data.images || {};
}

// Map of imageRef -> URL for image fills used in the file.
async function getImageFills(fileKey) {
  const data = await call(`/files/${fileKey}/images`);
  return (data.meta && data.meta.images) || {};
}

module.exports = {
  parseFileRef,
  normalizeNodeId,
  getFile,
  getFileMeta,
  getNodes,
  getStyles,
  getLocalVariables,
  getImageRenders,
  getImageFills,
};
