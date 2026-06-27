---
name: figma-to-code
description: Turn a Figma design into accurate front-end code. Use whenever the user shares a Figma link or file key and wants markup, CSS, components, design tokens, or exported icons/images — phrases like "code this Figma", "build this screen from Figma", "pull the design", "export the icons", "set up the design tokens", or "the design changed, re-pull it". Relies on the figma-connector MCP tools (figma_get_file, figma_get_node, figma_list_tokens, figma_export_assets, figma_check_updates).
---

# Figma to code

Build front-end code from Figma designs using the `figma-connector` MCP tools. The connector returns a normalized, code-ready schema — not raw Figma JSON — so trust its fields directly.

## Workflow

Work tokens-first, then layout, then assets. This order produces clean, themeable code instead of hard-coded magic values.

1. **Tokens first.** Call `figma_list_tokens` for the file. Map the result to CSS custom properties (or the project's theme system) before writing any component. Use `tokens.variables` when present; fall back to `tokens.styles`. If `tokens._variablesNote` says variables were unavailable, that is expected on non-Enterprise plans — use the style tokens.

2. **Structure next.** For a whole screen, call `figma_get_file`. For a single frame or while iterating, call `figma_get_node` with the node id (a `node-id` copied from a Figma URL works directly). Build the DOM from the `document`/`nodes` tree.

3. **Assets last.** Call `figma_export_assets` to download icons/images into the project. Reference the saved file paths it returns. Never inline-trace an icon by hand when the connector can export the real SVG.

## Reading the normalized schema

Each node has: `name`, `type`, `tag` (an HTML tag suggestion), optional `text`, `layout`, and `style`.

- `layout` is already CSS-shaped: `display: "flex"`, `flexDirection`, `gap`, `padding` (top/right/bottom/left string), `justifyContent`, `alignItems`, `width`, `height`. Translate it close to 1:1, but prefer the project's spacing tokens over raw pixel values where they match.
- `style.fill` / `style.stroke` are `{ type: "solid", color }` or gradient/image variants. `style.typography` carries `fontFamily`, `fontWeight`, `fontSize`, `lineHeight`, `letterSpacing`, `textAlign`. `style.effects[].css` is a ready-to-use `box-shadow` string. `style.borderRadius` is a number or a per-corner string.
- `tag` is a hint, not law — use semantic judgment (a node named "Button" gets `<button>`; large text becomes a heading).

## Components

`isComponent: true` marks a reusable component — generate one reusable component (React/Vue/etc.) rather than repeating markup. `instanceOf` + `props` on an instance tell you which component and which variant props to pass. Group repeated instances into a single component with props.

## Tokens → CSS

Emit variables as a theme block, then reference them everywhere:

```css
:root {
  --color-primary: #2962ff;   /* from tokens.variables or tokens.styles */
  --space-md: 16px;
  --radius-card: 12px;
}
```

Match node colors/spacing back to these variables instead of pasting literals. This is the main lever for code that survives design changes.

## Keeping in sync when the design changes

Designs change. The connector caches by file and tracks `lastModified`.

- Before re-coding an existing screen, call `figma_check_updates`. If `changed: true`, re-pull with `figma_get_file` and `refresh: true`, then re-export assets.
- The JSON cache lives outside the project (not under git). Exported assets are written into the project (they are real source the code imports).
- For automatic monitoring, offer to set up a scheduled task that runs `figma_check_updates` daily and notifies the user (and re-pulls) when the design changed.

## Output destinations

- Pass `saveToFolder: true` and `folderPath` to `figma_get_file` to drop the normalized JSON into the project for reference. Otherwise the data comes back inline and is cached.
- Assets always go to the project (`assetDir`, or `FIGMA_ASSET_DIR`, default `./figma-assets`).

## Notes

- Node ids look like `123:45`. A URL `node-id=123-45` is accepted and converted automatically.
- For very large files, pass `depth` to `figma_get_file` to cap tree depth, or pull screen-by-screen with `figma_get_node`.
- If a tool returns an auth error, the `FIGMA_TOKEN` is missing or lacks scope — tell the user to set it in the connector config.
