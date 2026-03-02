---
name: th0th-memory
description: Mandatory rules for using th0th semantic search, compression, and memory tools. Prioritize th0th tools over native tools (Glob, Grep, Read) to explore and understand code. Triggers on tasks involving code search, context compression, storing decisions, or retrieving project knowledge.
license: MIT
metadata:
  author: S1LV4
  version: "1.0.0"
---

# th0th-memory Skill

Mandatory rules for using th0th tools. Prioritize semantic search, compression, and memory over native tools (Glob, Grep, Read) to explore and understand code.

## When to Apply

Reference these guidelines when:
- Searching for code patterns or implementations
- Understanding codebase architecture
- Storing important decisions or patterns
- Compressing large code contexts
- Retrieving memories from previous sessions
- Analyzing usage and performance metrics

## Available Tools

| Priority | Tool | Use |
|----------|------|-----|
| 1 | `th0th_index` | Index project before searching |
| 2 | `th0th_search` | Semantic + keyword search with filters |
| 3 | `th0th_optimized_context` | Search + compress in one call |
| 4 | `th0th_remember` | Store important information |
| 5 | `th0th_recall` | Retrieve memories from previous sessions |
| 6 | `th0th_compress` | Reduce context size (70-98%) |
| 7 | `th0th_analytics` | Usage patterns and metrics |
| 8 | Glob/Grep/Read | Only when th0th doesn't find |

## Tool Reference

### 1. th0th_index

Index a project directory for semantic search.

```
th0th_index({
  projectPath: "/home/user/my-project",
  projectId: "my-project",
  forceReindex: false,
  warmCache: true
})
```

### 2. th0th_search

Semantic + keyword search with RRF (Reciprocal Rank Fusion).

```
th0th_search({
  query: "JWT authentication middleware",
  maxResults: 10,
  minScore: 0.3,
  include: ["src/**/*.ts"],
  exclude: ["**/*.test.*"]
})
```

### 3. th0th_optimized_context

Search + compress in one call. Maximum token efficiency.

```
th0th_optimized_context({
  query: "how does authentication work?",
  maxTokens: 4000,
  maxResults: 5
})
```

### 4. th0th_remember

Store important information in persistent memory.

```
th0th_remember({
  content: "Using PostgreSQL for user data",
  type: "decision",
  importance: 0.8,
  tags: ["database", "architecture"]
})
```

### 5. th0th_recall

Search stored memories from previous sessions.

```
th0th_recall({
  query: "database decisions",
  types: ["decision"],
  limit: 10,
  minImportance: 0.3
})
```

### 6. th0th_compress

Compress context (keeps structure, removes details).

```
th0th_compress({
  content: "...large code...",
  strategy: "code_structure",
  targetRatio: 0.7
})
```

### 7. th0th_analytics

Usage patterns, cache performance, metrics.

```
th0th_analytics({
  type: "summary",
  limit: 10
})
```

## Compression Strategies

| Strategy | Use Case | Reduction |
|----------|----------|-----------|
| `code_structure` | Source code | 70-90% |
| `conversation_summary` | Chat history | 80-95% |
| `semantic_dedup` | Repetitive content | 50-70% |
| `hierarchical` | Structured docs | 60-80% |

## Memory Types

| Type | Use |
|------|-----|
| `preference` | User preferences |
| `conversation` | Important conversation points |
| `code` | Code patterns discovered |
| `decision` | Architecture decisions |
| `pattern` | Recurring patterns |

## Decision Flow

```
Need to find code?
  → th0th_search (first)
  → Glob/Grep/Read (fallback)

Need to understand architecture?
  → th0th_recall (check memories first)
  → th0th_search (explore code)

Found important pattern/decision?
  → th0th_remember (store for future)

Context too large?
  → th0th_compress (reduce tokens)

Maximum efficiency needed?
  → th0th_optimized_context (search + compress)
```
