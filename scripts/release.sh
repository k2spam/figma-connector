#!/usr/bin/env bash
# Release helper: bump version, sync it into marketplace.json, rebuild the .plugin.
#
# Usage:
#   ./scripts/release.sh            # keep current version, just re-stamp + rebuild
#   ./scripts/release.sh patch      # 0.1.3 -> 0.1.4
#   ./scripts/release.sh minor      # 0.1.3 -> 0.2.0
#   ./scripts/release.sh major      # 0.1.3 -> 1.0.0
#   ./scripts/release.sh 1.2.3      # set an explicit version
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

PLUGIN_JSON=".claude-plugin/plugin.json"
MARKET_JSON=".claude-plugin/marketplace.json"
BUMP="${1:-}"

# 1. Resolve the new version (in Node, so no jq dependency) and write it to plugin.json.
VERSION="$(node -e '
  const fs = require("fs");
  const f = process.argv[1];
  const bump = process.argv[2] || "";
  const j = JSON.parse(fs.readFileSync(f, "utf8"));
  let [maj, min, pat] = String(j.version || "0.0.0").split(".").map(Number);
  if (bump === "patch") pat++;
  else if (bump === "minor") { min++; pat = 0; }
  else if (bump === "major") { maj++; min = 0; pat = 0; }
  else if (/^\d+\.\d+\.\d+$/.test(bump)) [maj, min, pat] = bump.split(".").map(Number);
  else if (bump) { console.error("Bad version arg: " + bump); process.exit(1); }
  j.version = `${maj}.${min}.${pat}`;
  fs.writeFileSync(f, JSON.stringify(j, null, 2) + "\n");
  process.stdout.write(j.version);
' "$PLUGIN_JSON" "$BUMP")"

# 2. Stamp the same version into the marketplace plugin entry.
node -e '
  const fs = require("fs");
  const f = process.argv[1];
  const v = process.argv[2];
  const m = JSON.parse(fs.readFileSync(f, "utf8"));
  (m.plugins || []).forEach((p) => { if (p.name === "figma-connector") p.version = v; });
  fs.writeFileSync(f, JSON.stringify(m, null, 2) + "\n");
' "$MARKET_JSON" "$VERSION"

# 3. Rebuild the .plugin bundle (only runtime files; no docs/build/git).
NAME="figma-connector-$VERSION.plugin"
TMP="$(mktemp -d)"
zip -r -q "$TMP/$NAME" . \
  -x "*.DS_Store" "docs/*" "build/*" ".git/*" "*/node_modules/*" "*.plugin" "scripts/*"
mkdir -p build
rm -f build/*.plugin
cp "$TMP/$NAME" "build/$NAME"
rm -rf "$TMP"

echo "Released version $VERSION"
echo "  - $PLUGIN_JSON      -> $VERSION"
echo "  - $MARKET_JSON      -> $VERSION"
echo "  - build/$NAME"
echo
echo "Next: commit & push, then Sync the marketplace and click Update in Claude."
