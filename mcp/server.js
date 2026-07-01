#!/usr/bin/env node
// Zero-dependency MCP stdio server (newline-delimited JSON-RPC 2.0).
// Exposes Figma read/export tools to Claude. Requires Node 18+ (global fetch).

const fs = require("fs");
const path = require("path");
const api = require("./figma-api");
const norm = require("./normalize");
const cache = require("./cache");
const assets = require("./assets");

let VERSION = "0.0.0";
try {
  VERSION = require("../.claude-plugin/plugin.json").version || VERSION;
} catch (_) {
  /* keep fallback */
}
const SERVER = { name: "figma-connector", version: VERSION };
const PROTOCOL = "2024-11-05";

// ---------- helpers ----------

function log(...args) {
  // stderr only — stdout is reserved for the JSON-RPC channel.
  process.stderr.write("[figma-connector] " + args.join(" ") + "\n");
}

function normalizeDocument(fileDoc) {
  const styleSink = {};
  const pages = (fileDoc.document.children || []).map((page) =>
    norm.normalizeNode(page, { styleSink })
  );
  return { pages, styleSink };
}

async function buildFileBundle(ref, { depth, refresh, include } = {}) {
  const { fileKey } = api.parseFileRef(ref);
  const inc = include || ["document", "tokens"];

  const meta = await api.getFileMeta(fileKey);
  const live = { name: meta.name, lastModified: meta.lastModified, version: meta.version };

  // Serve cache when fresh, unless refresh requested.
  if (!refresh && !cache.isStale(fileKey, live.lastModified)) {
    const cached = cache.readJson(fileKey, "bundle.json");
    if (cached) {
      cached._cache = "hit";
      return cached;
    }
  }

  const fileDoc = await api.getFile(fileKey, { depth });
  const { pages, styleSink } = normalizeDocument(fileDoc);

  const bundle = {
    file: { key: fileKey, ...live },
    _cache: refresh ? "refreshed" : "miss",
  };

  if (inc.includes("tokens") || inc.includes("styles")) {
    bundle.tokens = bundle.tokens || {};
    bundle.tokens.styles = norm.buildStyleTokens(fileDoc.styles || {}, styleSink);
  }
  if (inc.includes("tokens") || inc.includes("variables")) {
    try {
      const vars = await api.getLocalVariables(fileKey);
      bundle.tokens = bundle.tokens || {};
      bundle.tokens.variables = norm.buildVariableTokens(vars);
    } catch (e) {
      bundle.tokens = bundle.tokens || {};
      bundle.tokens.variables = null;
      bundle.tokens._variablesNote =
        "Local variables unavailable (the Figma variables API requires an Enterprise plan, or the token lacks scope). Style tokens were used instead.";
    }
  }
  if (inc.includes("document")) bundle.document = pages;

  cache.writeJson(fileKey, "bundle.json", bundle);
  cache.writeStamp(fileKey, live);
  return bundle;
}

// Load the cached full bundle for a file, pulling & caching it once if missing.
async function ensureBundle(fileRef, { refresh } = {}) {
  const { fileKey } = api.parseFileRef(fileRef);
  let bundle = refresh ? null : cache.readJson(fileKey, "bundle.json");
  if (!bundle) {
    bundle = await buildFileBundle(fileRef, { include: ["document", "tokens"], refresh });
  }
  return { fileKey, bundle };
}

function findNodeById(nodes, id) {
  for (const n of nodes || []) {
    if (n.id === id) return n;
    const hit = findNodeById(n.children, id);
    if (hit) return hit;
  }
  return null;
}

// Full detail, but children pruned beyond maxDepth (replaced with a count).
function pruneDepth(node, maxDepth, depth = 0) {
  const copy = { ...node };
  if (node.children && node.children.length) {
    if (depth >= maxDepth) {
      copy.children = undefined;
      copy.childrenCount = node.children.length;
    } else {
      copy.children = node.children.map((c) => pruneDepth(c, maxDepth, depth + 1));
    }
  }
  return copy;
}

// Skeleton only: id / name / type / tag / size + nested outline (or child count).
function toOutline(node, maxDepth, depth = 0) {
  const o = { id: node.id, name: node.name, type: node.type, tag: node.tag };
  const w = node.layout && node.layout.width;
  const h = node.layout && node.layout.height;
  if (w != null || h != null) o.size = [w != null ? w : null, h != null ? h : null];
  if (node.text) o.text = node.text.length > 40 ? node.text.slice(0, 40) + "…" : node.text;
  if (node.isComponent) o.isComponent = true;
  if (node.instanceOf) o.instanceOf = node.instanceOf;
  if (node.children && node.children.length) {
    o.childrenCount = node.children.length;
    if (depth < maxDepth) o.children = node.children.map((c) => toOutline(c, maxDepth, depth + 1));
  }
  return o;
}

// ---------- tool implementations ----------

const TOOLS = {
  figma_get_file: {
    description:
      "Pull an ENTIRE Figma file once and cache the full normalized data locally (layout, fills, typography, effects, components, tokens). Returns a compact response — file info, design tokens, and a shallow outline (skeleton) — NOT the full tree, so it never overflows. After this, use figma_get_node / figma_outline to read any part from the local cache with no further API calls.",
    inputSchema: {
      type: "object",
      properties: {
        file: { type: "string", description: "Figma file URL or file key." },
        refresh: { type: "boolean", description: "Ignore cache and re-pull from Figma (after a design change)." },
        outlineDepth: { type: "number", description: "Depth of the skeleton outline returned inline. Default 3." },
        saveToFolder: {
          type: "boolean",
          description: "Also write the full JSON into the project (path from folderPath).",
        },
        folderPath: { type: "string", description: "Directory to write the full JSON into when saveToFolder is true." },
      },
      required: ["file"],
    },
    async run(args) {
      const bundle = await buildFileBundle(args.file, {
        refresh: args.refresh,
        include: ["document", "tokens"],
      });
      const { fileKey } = api.parseFileRef(args.file);
      const cachePath = cache.fileFor(fileKey, "bundle.json");
      let folderPath = null;
      if (args.saveToFolder) {
        const dir = args.folderPath || process.cwd();
        fs.mkdirSync(dir, { recursive: true });
        folderPath = path.join(dir, `figma-${fileKey}.json`);
        fs.writeFileSync(folderPath, JSON.stringify(bundle, null, 2));
      }
      const pages = bundle.document || [];
      const outlineDepth = args.outlineDepth != null ? args.outlineDepth : 3;
      return {
        file: bundle.file,
        cache: bundle._cache,
        savedTo: { cache: cachePath, folder: folderPath },
        tokens: bundle.tokens,
        outline: pages.map((p) => toOutline(p, outlineDepth)),
        next:
          "Full data is cached locally. Call figma_get_node (reads the cache) for any node in full, or figma_outline for a deeper skeleton — no more API calls.",
      };
    },
  },

  figma_get_node: {
    description:
      "Read one or more nodes/frames IN FULL detail from the locally cached file (normalized layout, fills, typography, effects, components). Reads from the local cache — the whole file is pulled & cached once automatically if not present. Pass depth to cap how deep the subtree goes.",
    inputSchema: {
      type: "object",
      properties: {
        file: { type: "string", description: "Figma file URL or file key." },
        nodeIds: {
          type: "array",
          items: { type: "string" },
          description: "Node IDs (e.g. '123:45'). A node-id from a URL also works.",
        },
        depth: { type: "number", description: "Max subtree depth to return (children beyond it become a count). Default: full." },
        refresh: { type: "boolean", description: "Re-pull the file from Figma before reading." },
      },
      required: ["file", "nodeIds"],
    },
    async run(args) {
      const { bundle } = await ensureBundle(args.file, { refresh: args.refresh });
      const pages = bundle.document || [];
      const maxDepth = args.depth != null ? args.depth : Infinity;
      const nodes = (args.nodeIds || []).map((raw) => {
        const id = api.normalizeNodeId(raw);
        const found = findNodeById(pages, id) || findNodeById(pages, raw);
        return found ? pruneDepth(found, maxDepth) : { id: raw, error: "not found in file" };
      });
      return { file: bundle.file, source: "local-cache", nodes };
    },
  },

  figma_outline: {
    description:
      "Return a compact skeleton (id / name / type / tag / size, nested) of the file or a node — no styles. Reads the local cache (pulling the file once if needed). Use it to navigate a large design and pick node ids to read in full with figma_get_node.",
    inputSchema: {
      type: "object",
      properties: {
        file: { type: "string", description: "Figma file URL or file key." },
        nodeId: { type: "string", description: "Root node for the outline. Omit for the whole file." },
        depth: { type: "number", description: "How deep the skeleton goes. Default 4." },
        refresh: { type: "boolean", description: "Re-pull the file from Figma before reading." },
      },
      required: ["file"],
    },
    async run(args) {
      const { bundle } = await ensureBundle(args.file, { refresh: args.refresh });
      const pages = bundle.document || [];
      const depth = args.depth != null ? args.depth : 4;
      let roots = pages;
      if (args.nodeId) {
        const n = findNodeById(pages, api.normalizeNodeId(args.nodeId)) || findNodeById(pages, args.nodeId);
        roots = n ? [n] : [];
      }
      return { file: bundle.file, source: "local-cache", outline: roots.map((r) => toOutline(r, depth)) };
    },
  },

  figma_export_assets: {
    description:
      "Render and download icons/images from a Figma file into the project folder. Give explicit nodeIds, or omit them to auto-collect vectors and image nodes from the whole file. Defaults to SVG.",
    inputSchema: {
      type: "object",
      properties: {
        file: { type: "string", description: "Figma file URL or file key." },
        nodeIds: {
          type: "array",
          items: { type: "string" },
          description: "Nodes to export. If omitted, exportable nodes are auto-collected.",
        },
        format: { type: "string", enum: ["svg", "png", "jpg", "pdf"], description: "Default svg." },
        scale: { type: "number", description: "Raster scale for png/jpg. Default 2." },
        assetDir: { type: "string", description: "Output directory (defaults to ./figma-assets or FIGMA_ASSET_DIR)." },
      },
      required: ["file"],
    },
    async run(args) {
      const { fileKey } = api.parseFileRef(args.file);
      let nodes;
      if (args.nodeIds && args.nodeIds.length) {
        const data = await api.getNodes(fileKey, args.nodeIds);
        nodes = Object.values(data.nodes || {})
          .filter(Boolean)
          .map((n) => ({ id: n.document.id, name: n.document.name }));
      } else {
        const bundle = await buildFileBundle(args.file, { include: ["document"] });
        const collected = [];
        (bundle.document || []).forEach((p) => assets.collectExportable(p, collected));
        nodes = collected;
      }
      const result = await assets.exportNodes(fileKey, nodes, {
        format: args.format || "svg",
        scale: args.scale || 2,
        assetDir: args.assetDir,
      });
      return {
        file: { key: fileKey },
        exported: result.saved.length,
        dir: result.dir,
        format: result.format,
        files: result.saved,
      };
    },
  },

  figma_check_updates: {
    description:
      "Check whether a Figma file changed since it was last pulled. Compares the live lastModified timestamp against the local cache. Use this (e.g. on a schedule) to decide whether to re-pull.",
    inputSchema: {
      type: "object",
      properties: {
        file: { type: "string", description: "Figma file URL or file key." },
      },
      required: ["file"],
    },
    async run(args) {
      const { fileKey } = api.parseFileRef(args.file);
      const meta = await api.getFileMeta(fileKey);
      const stamp = cache.readStamp(fileKey);
      const stale = cache.isStale(fileKey, meta.lastModified);
      return {
        file: { key: fileKey, name: meta.name },
        live: { lastModified: meta.lastModified, version: meta.version },
        cached: stamp || null,
        changed: stale,
        recommendation: stale
          ? "Design changed — re-pull with figma_get_file refresh=true."
          : "Cache is up to date.",
      };
    },
  },

  figma_list_tokens: {
    description:
      "Return only the design tokens (variables + styles) for a Figma file, without the node tree. Lightweight — good for setting up CSS variables / a theme before building components.",
    inputSchema: {
      type: "object",
      properties: {
        file: { type: "string", description: "Figma file URL or file key." },
        refresh: { type: "boolean", description: "Ignore cache and re-pull." },
      },
      required: ["file"],
    },
    async run(args) {
      const bundle = await buildFileBundle(args.file, {
        refresh: args.refresh,
        include: ["tokens"],
      });
      return { file: bundle.file, tokens: bundle.tokens, cache: bundle._cache };
    },
  },
};

// ---------- JSON-RPC plumbing ----------

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function reply(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function replyError(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

async function handle(msg) {
  const { id, method, params } = msg;

  if (method === "initialize") {
    return reply(id, {
      protocolVersion: PROTOCOL,
      capabilities: { tools: {} },
      serverInfo: SERVER,
    });
  }
  if (method === "notifications/initialized" || method === "initialized") return; // no response
  if (method === "ping") return reply(id, {});

  if (method === "tools/list") {
    const tools = Object.entries(TOOLS).map(([name, t]) => ({
      name,
      description: t.description,
      inputSchema: t.inputSchema,
    }));
    return reply(id, { tools });
  }

  if (method === "tools/call") {
    const name = params && params.name;
    const tool = TOOLS[name];
    if (!tool) return replyError(id, -32601, `Unknown tool: ${name}`);
    try {
      const result = await tool.run((params && params.arguments) || {});
      return reply(id, {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      });
    } catch (e) {
      log("tool error:", name, e.message);
      return reply(id, {
        content: [{ type: "text", text: `Error in ${name}: ${e.message}` }],
        isError: true,
      });
    }
  }

  if (id !== undefined) replyError(id, -32601, `Method not found: ${method}`);
}

// ---------- stdin loop ----------

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch (e) {
      log("bad JSON:", line.slice(0, 120));
      continue;
    }
    Promise.resolve(handle(msg)).catch((e) => log("handler crash:", e.message));
  }
});

process.stdin.on("end", () => process.exit(0));
log(`ready (node ${process.version})`);
