---
description: Semantic search in an indexed project (th0th)
argument-hint: "<query>"
allowed-tools: ["mcp__th0th__th0th_search", "mcp__th0th__th0th_list_projects"]
---

Run a semantic code search with th0th.

Query: `$ARGUMENTS`

Steps:
1. Resolve the active project:
   - Prefer the projectId of the cwd if it's already indexed (call `th0th_list_projects` and match by path basename).
   - If ambiguous, ask the user.
2. Call `mcp__th0th__th0th_search` with `query="$ARGUMENTS"`, `projectId=<resolved>`, `limit=10`.
3. Return a ranked list of hits: `filePath:lineStart-lineEnd — score — label`. For the top 3 results, include 3-5 lines of the matched snippet.
4. If 0 results, check whether vector store has orphaned chunks (look at previous `/map` output or prompt the user to `/index` with `forceReindex=true`).

Keep the output scannable — no walls of text.
