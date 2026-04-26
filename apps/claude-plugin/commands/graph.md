---
description: Show references / call graph for a symbol in an indexed project
argument-hint: "<symbolName>"
allowed-tools: ["mcp__th0th__th0th_get_references", "mcp__th0th__th0th_go_to_definition", "mcp__th0th__th0th_list_projects"]
---

Show the reference graph for `$ARGUMENTS`.

Steps:
1. Resolve projectId from cwd (`th0th_list_projects` match by path basename).
2. Call `mcp__th0th__th0th_go_to_definition` with `symbolName=$ARGUMENTS` to locate the definition first.
3. Call `mcp__th0th__th0th_get_references` with the same `symbolName` (and `fqn` if provided by the definition lookup).
4. Group the results by file, sorted by reference count descending.
5. For each file, list `line — ref_kind — context snippet` (keep snippet to 1 line).

If 0 references, the symbol might be defined but unused — note that. If 0 definitions and 0 references, the name might be case-sensitive or a FQN is needed.
