# th0th — Claude Code plugin

Slash commands and a specialized subagent that make th0th feel native in Claude Code.

## What you get

Slash commands (installed as `/th0th-*`):

| Command | What it does |
|---------|--------------|
| `/th0th-map` | Project map: stats, top central files, symbols by kind, languages, recent indexes |
| `/th0th-index [projectId]` | Index the cwd (polls status, reports ETA) |
| `/th0th-find <query>` | Semantic code search |
| `/th0th-def <symbol>` | Go-to-definition (exact then fuzzy fallback) |
| `/th0th-graph <symbol>` | Reference graph (who calls / imports / extends) |
| `/th0th-status` | Workspaces health + search analytics |

Subagent:

- **`th0th-navigator`** — exploration specialist that prefers semantic queries over blind file reads. Protects the parent agent's context during large investigations.

## Install

```bash
# user scope (~/.claude), default
apps/claude-plugin/install.sh

# or project scope (./.claude)
apps/claude-plugin/install.sh --project
```

Restart Claude Code to pick up the new commands.

## Prerequisites

The th0th MCP server must be registered for Claude Code. See `apps/mcp-client/README.md`.

A quick check after install:

```
/th0th-status
```

If nothing shows up, the MCP server probably isn't running — start it with the dev-server command from the th0th repo.
