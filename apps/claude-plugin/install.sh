#!/usr/bin/env bash
#
# th0th Claude Code plugin installer
#
# Copies slash commands and the th0th-navigator subagent into the user's
# Claude Code config directory. Idempotent — safe to re-run.
#
# Usage:
#   apps/claude-plugin/install.sh           # install at user scope (~/.claude)
#   apps/claude-plugin/install.sh --project # install at project scope (./.claude)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCOPE="user"

for arg in "$@"; do
  case "$arg" in
    --project) SCOPE="project" ;;
    --user) SCOPE="user" ;;
    -h|--help)
      echo "Usage: $0 [--user|--project]"
      exit 0
      ;;
  esac
done

# Banner
source "$SCRIPT_DIR/../../scripts/banner.sh"
th0th_banner

if [[ "$SCOPE" == "project" ]]; then
  TARGET="$(pwd)/.claude"
else
  TARGET="$HOME/.claude"
fi

echo "Installing th0th Claude Code plugin to: $TARGET"
mkdir -p "$TARGET/commands" "$TARGET/agents"

# Slash commands — prefix with 'th0th-' to avoid collisions with user commands
for src in "$SCRIPT_DIR/commands/"*.md; do
  name="$(basename "$src" .md)"
  dest="$TARGET/commands/th0th-${name}.md"
  cp "$src" "$dest"
  echo "  + /th0th-${name}"
done

# Subagent — keep original name
cp "$SCRIPT_DIR/agents/th0th-navigator.md" "$TARGET/agents/th0th-navigator.md"
echo "  + agent: th0th-navigator"

echo ""
echo "Done. Restart Claude Code to pick up the new commands."
echo ""
echo "Next steps:"
echo "  1. Make sure the th0th MCP server is registered (see apps/mcp-client/README.md)."
echo "  2. Try: /th0th-status"
echo "  3. Try: /th0th-map (on an indexed project)"
