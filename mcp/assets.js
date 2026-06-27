// Exports icons/images from Figma and saves them INTO the project (assets are
// real source that the code references, unlike the JSON cache).

const fs = require("fs");
const path = require("path");
const api = require("./figma-api");

function assetRoot(override) {
  if (override) return override;
  if (process.env.FIGMA_ASSET_DIR) return process.env.FIGMA_ASSET_DIR;
  return path.join(process.cwd(), "figma-assets");
}

function sanitize(name, fallback) {
  const clean = String(name || fallback || "asset")
    .replace(/[\\/:*?"<>|]/g, "")
    .replace(/\s+/g, "-")
    .replace(/[^A-Za-z0-9._-]/g, "")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  return clean || fallback || "asset";
}

async function download(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed ${res.status} for ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(dest, buf);
  return buf.length;
}

// nodes: array of { id, name }. Renders each to `format` and writes files.
async function exportNodes(fileKey, nodes, { format = "svg", scale = 2, assetDir } = {}) {
  if (!nodes || !nodes.length) return { saved: [], dir: null };
  const dir = assetRoot(assetDir);
  fs.mkdirSync(dir, { recursive: true });

  const ids = nodes.map((n) => n.id);
  const urls = await api.getImageRenders(fileKey, ids, { format, scale });

  const saved = [];
  const seen = {};
  for (const node of nodes) {
    const url = urls[api.normalizeNodeId(node.id)] || urls[node.id];
    if (!url) {
      saved.push({ id: node.id, name: node.name, error: "no render url returned" });
      continue;
    }
    let base = sanitize(node.name, node.id.replace(/[:]/g, "-"));
    seen[base] = (seen[base] || 0) + 1;
    if (seen[base] > 1) base = `${base}-${seen[base]}`;
    const filename = `${base}.${format}`;
    const dest = path.join(dir, filename);
    try {
      const bytes = await download(url, dest);
      saved.push({ id: node.id, name: node.name, file: dest, filename, bytes });
    } catch (e) {
      saved.push({ id: node.id, name: node.name, error: e.message });
    }
  }
  return { saved, dir, format, scale };
}

// Walk a normalized tree and collect nodes worth exporting as assets:
// vectors, icon-like groups, and image fills.
function collectExportable(normNode, acc = []) {
  if (!normNode) return acc;
  const t = normNode.type;
  const hasImageFill =
    normNode.style &&
    [].concat(normNode.style.fill || []).some((f) => f && f.type === "image");
  if (t === "VECTOR" || t === "BOOLEAN_OPERATION" || normNode.tag === "img" || hasImageFill) {
    acc.push({ id: normNode.id, name: normNode.name });
    return acc; // don't descend into an exported asset
  }
  (normNode.children || []).forEach((c) => collectExportable(c, acc));
  return acc;
}

module.exports = { assetRoot, exportNodes, collectExportable, sanitize };
