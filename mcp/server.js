#!/usr/bin/env node
// Zero-dependency MCP stdio server (newline-delimited JSON-RPC 2.0).
// Exposes Figma read/export tools to Claude. Requires Node 18+ (global fetch).

const fs = require("fs");
const path = require("path");
const api = require("./figma-api");
const norm = require("./normalize");
const cache = require("./cache");
const assets = require("./assets");

const SERVER = { name: "figma-connector", version: "0.1.0" };
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

// ---------- tool implementations ----------

const TOOLS = {
  figma_get_file: {
    description:
      "Pull a whole Figma file as clean, code-ready JSON: normalized layout (flex/gap/padding), fills, typography, effects, components, plus design tokens (variables + styles). Results are cached; pass refresh=true to force a re-pull after the design changed.",
    inputSchema: {
      type: "object",
      properties: {
        file: { type: "string", description: "Figma file URL or file key." },
        depth: {
          type: "number",
          description: "Optional max tree depth (smaller = lighter payload for huge files).",
        },
        include: {
          type: "array",
          items: { type: "string", enum: ["document", "tokens", "styles", "variables"] },
          description: "Which sections to return. Default: document + tokens.",
        },
        refresh: { type: "boolean", description: "Ignore cache and re-pull from Figma." },
        saveToFolder: {
          type: "boolean",
          description: "Also write the JSON into the project (path from folderPath).",
        },
        folderPath: { type: "string", description: "Directory to write the JSON into when saveToFolder is true." },
      },
      required: ["file"],
    },
    async run(args) {
      const bundle = await buildFileBundle(args.file, {
        depth: args.depth,
        refresh: args.refresh,
        include: args.include,
      });
      let savedPath = null;
      if (args.saveToFolder) {
        const dir = args.folderPath || process.cwd();
        fs.mkdirSync(dir, { recursive: true });
        savedPath = path.join(dir, `figma-${bundle.file.key}.json`);
        fs.writeFileSync(savedPath, JSON.stringify(bundle, null, 2));
      }
      return {
        summary: {
          file: bundle.file,
          cache: bundle._cache,
          savedToFolder: savedPath,
          cachedAt: cache.cacheRoot(),
        },
        bundle,
      };
    },
  },

  figma_get_node: {
    description:
      "Pull one or more specific nodes/frames from a Figma file as normalized, code-ready JSON. Use this iteratively while coding a screen — cheaper than the whole file.",
    inputSchema: {
      type: "object",
      properties: {
        file: { type: "string", description: "Figma file URL or file key." },
        nodeIds: {
          type: "array",
          items: { type: "string" },
          description: "Node IDs (e.g. '123:45'). A node-id from a URL also works.",
        },
        depth: { type: "number", description: "Optional max tree depth." },
      },
      required: ["file", "nodeIds"],
    },
    async run(args) {
      const { fileKey } = api.parseFileRef(args.file);
      const data = await api.getNodes(fileKey, args.nodeIds);
      const styleSink = {};
      const nodes = Object.values(data.nodes || {})
        .filter(Boolean)
        .map((n) => norm.normalizeNode(n.document, { styleSink, maxDepth: args.depth || Infinity }));
      return { file: { key: fileKey }, nodes };
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
