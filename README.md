# Figma Connector

A Claude plugin that pulls **clean, code-ready data** from Figma straight into Claude — no console, no manual `curl`, no copy-pasting JSON.

It wraps the Figma REST API in a local MCP server that **normalizes** the response into a layout/tokens/components schema designed for writing markup, then exposes it to Claude as native tools. It also exports icons and images into your project.

## Why

The official Figma MCP and raw REST API return data that is either too shallow or too noisy to code from reliably. This connector replicates the proven "dump the file, then read it" workflow, but does the normalization and asset export for you, and lets Claude call it directly.

## What's inside

- **MCP server** (`mcp/server.js`) — zero dependencies, runs on Node 18+ (uses the built-in `fetch`).
- **Skill** (`skills/figma-to-code`) — teaches Claude a tokens → layout → assets workflow.

### Tools

| Tool | Purpose |
|------|---------|
| `figma_get_file` | Pull the whole file once, cache it locally, return tokens + a compact skeleton (not the full tree). |
| `figma_outline` | Skeleton (id/name/type/tag/size) of the file or a node, from the local cache — for navigation. |
| `figma_get_node` | Read node(s) in full detail from the local cache; the file is pulled once automatically if needed. |
| `figma_list_tokens` | Just the design tokens (variables + styles). |
| `figma_export_assets` | Render & download icons/images (SVG/PNG/JPG/PDF) into the project. |
| `figma_check_updates` | Detect whether the design changed since the last pull. |

The model is **pull once, then browse locally**: `figma_get_file` fetches everything and caches it, and `figma_outline` / `figma_get_node` read from that cache with no further API calls until you `refresh`.

## Installation

The recommended way is to add this repository as a plugin **marketplace** — you get one‑click install plus future updates via **Sync**.

1. In the Claude desktop app open **Customize → Plugins**, click the **+** next to Local uploads and choose **Add marketplace**.

   ![Local uploads → + → Add marketplace](docs/images/install-4-upload-menu.png)

2. In the **URL** field enter the repository — `k2spam/figma-connector` (GitHub `owner/repo`) or the full `https://github.com/k2spam/figma-connector`. Point it at the **repo root**, not a subfolder like `/tree/main/build`.

   ![Add marketplace — enter the repository](docs/images/marketplace-1-enter-url.png)

3. Choose **Use "…"** for the URL you typed, then click **Sync**. The marketplace loads and you can install the **figma-connector** plugin from it.

   ![Add marketplace — confirm the repository](docs/images/marketplace-2-use-url.png)

To update later, re-open the marketplace and click **Sync** — it pulls the latest code from `main`.

### Alternative: install a local build

Prefer not to use GitHub? Upload the `.plugin` from `build/` directly: **Customize → Plugins → Personal → Local uploads → + → Upload plugin**, then drag the file in and click **Upload**.

Either way, set your token (below) and you're ready.

## Setup

1. Create a Figma **personal access token**: Figma → Settings → Security → Personal access tokens. Give it at least *File content: read* (and *Variables: read* if on Enterprise and you want variable tokens).
2. Set the token — easiest via the token file (see below).

Optional environment variables:

- `FIGMA_ASSET_DIR` — where exported icons/images are written (default `./figma-assets`).
- `FIGMA_CACHE_DIR` — where normalized JSON is cached (default `~/.cache/figma-connector`). This is intentionally **outside your repo** — designs are not source.

### Setting the token

**Recommended — token file.** Save your token to a file the server reads automatically when the `FIGMA_TOKEN` env var is empty. This survives plugin updates and needs no config editing:

```bash
mkdir -p ~/.config/figma-connector
printf 'figd_your_token_here' > ~/.config/figma-connector/token
```

(You can also point `FIGMA_TOKEN_FILE` at a custom location.) Then restart Claude or reconnect the plugin.

> **Note:** In the desktop app, the connector's **Environment Variables** panel (Customize → Connectors → figma-connector) is currently **view-only** — you can see `FIGMA_TOKEN` there but not edit it. That's why the token file above is the recommended path. If you added the server manually (not via the `.plugin`), you can instead set `FIGMA_TOKEN` in `claude_desktop_config.json` (`Settings → Developer → Edit Config`) under `mcpServers → figma-connector → env`.

## Usage

Just share a Figma link with Claude: "code this screen" + a Figma URL. Claude will pull tokens, build the layout, and export assets. A `node-id` from the URL is used automatically to target a specific frame.

### Keeping in sync

Designs change. The cache tracks each file's `lastModified`.

- Manual refresh: ask Claude to "re-pull the design" — it calls `figma_get_file` with `refresh: true`.
- Automatic: ask Claude to set up a scheduled task that runs `figma_check_updates` (e.g. daily) and re-pulls + notifies you when the design changed.

## Notes & limits

- The **variables** API (`figma_list_tokens` → `tokens.variables`) is Figma **Enterprise-only**. On other plans the connector falls back to **style tokens** automatically.
- Asset export uses Figma's image-render endpoint; very large batches are rendered per request and downloaded sequentially.
- All network calls go only to `api.figma.com`. The token never leaves your machine.

## Development

```bash
# Quick protocol smoke test (no token needed):
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  | node mcp/server.js
```

License: MIT.
