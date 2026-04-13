#!/usr/bin/env bun
/**
 * th0th - Stack Diagnostic Tool
 *
 * Validates the entire local infrastructure in seconds:
 * 1. Ollama installation
 * 2. Ollama API connectivity
 * 3. Required embedding model
 * 4. Embedding generation test
 * 5. PostgreSQL connectivity
 * 6. pgvector extension
 * 7. Prisma schema / migrations
 *
 * Usage: bun scripts/diagnose.ts
 *
 * Environment variables:
 *   OLLAMA_BASE_URL           - Ollama API URL (default: http://localhost:11434)
 *   OLLAMA_EMBEDDING_MODEL    - Model to test (default: bge-m3)
 *   DATABASE_URL              - PostgreSQL connection string (optional)
 */
import { spawn } from "bun";

const BOLD = "\x1b[1m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const DIM = "\x1b[2m";
const NC = "\x1b[0m";

console.log(
  `\n${BOLD}╔═══════════════════════════════════════════════════════════════╗${NC}`,
);
console.log(
  `${BOLD}║            th0th - Stack Diagnostic Tool                      ║${NC}`,
);
console.log(
  `${BOLD}╚═══════════════════════════════════════════════════════════════╝${NC}\n`,
);

// ─── Helpers ──────────────────────────────────────────────────────────

/** Mask DATABASE_URL for safe logging — only shows host and database name */
function maskDatabaseUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname || "unknown";
    const port = parsed.port ? `:${parsed.port}` : "";
    const db = parsed.pathname.replace(/^\//, "") || "unknown";
    return `postgres://****:****@${host}${port}/${db}`;
  } catch {
    // Fallback: mask everything between :// and @
    return url.replace(/\/\/.*@/, "//****:****@");
  }
}

/** Run a shell command and return stdout, or null on failure */
async function run(
  cmd: string[],
  timeoutMs = 5000,
): Promise<string | null> {
  try {
    const proc = spawn(cmd);
    const timer = setTimeout(() => proc.kill(), timeoutMs);
    const out = await new Response(proc.stdout).text();
    clearTimeout(timer);
    return out.trim() || null;
  } catch {
    return null;
  }
}

// ─── Ollama URL auto-detection ───────────────────────────────────────

/** Candidate URLs to probe, in priority order */
function ollamaCandidates(envUrl: string): string[] {
  const candidates: string[] = [envUrl];

  // When the env URL uses "localhost", also try the explicit IPv4 address.
  // In WSL2 with mirrored networking, "localhost" may resolve to ::1 (IPv6)
  // while Ollama only listens on 127.0.0.1 (IPv4).
  if (envUrl.includes("localhost")) {
    candidates.push(envUrl.replace("localhost", "127.0.0.1"));
  }

  // Try the WSL2 Windows-host nameserver IP as a last resort
  try {
    const resolv = Bun.file("/etc/resolv.conf").toString();
    const match = resolv.match(/^nameserver\s+([\d.]+)/m);
    if (match) candidates.push(`http://${match[1]}:11434`);
  } catch { /* ignore */ }

  // Deduplicate while preserving order
  return [...new Set(candidates)];
}

/** Probe each candidate URL and return the first one that responds, or null */
async function detectOllamaUrl(candidates: string[]): Promise<{ url: string; data: { models?: Array<{ name: string }> } } | null> {
  for (const url of candidates) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 2000);
      const response = await fetch(`${url}/api/tags`, { signal: controller.signal });
      clearTimeout(timeoutId);
      if (response.ok) {
        const data = (await response.json()) as { models?: Array<{ name: string }> };
        return { url, data };
      }
    } catch { /* try next */ }
  }
  return null;
}

// ─── Ollama Checks ───────────────────────────────────────────────────

async function checkOllama(): Promise<boolean> {
  const envUrl = process.env.OLLAMA_BASE_URL || "http://localhost:11434";
  const modelName = process.env.OLLAMA_EMBEDDING_MODEL || "bge-m3";
  let ok = true;
  let resolvedUrl = envUrl;

  // 1. Check if Ollama is in PATH
  console.log(`${BOLD}[1/7] Checking Ollama installation...${NC}`);
  const ollamaPath = await run(["which", "ollama"]);
  if (ollamaPath) {
    console.log(`  ${GREEN}✓${NC} Ollama found at: ${ollamaPath}`);
  } else {
    console.log(
      `  ${RED}✗${NC} Ollama not found in PATH`,
    );
    console.log(
      `  ${YELLOW}!${NC} Install: curl -fsSL https://ollama.com/install.sh | sh`,
    );
    ok = false;
  }

  // 2. Check API connectivity — probe multiple candidates to handle WSL2 quirks
  console.log(`\n${BOLD}[2/7] Checking Ollama API connectivity...${NC}`);
  const candidates = ollamaCandidates(envUrl);
  let modelsData: { models?: Array<{ name: string }> } | null = null;

  const start = Date.now();
  const detected = await detectOllamaUrl(candidates);
  const duration = Date.now() - start;

  if (detected) {
    resolvedUrl = detected.url;
    modelsData = detected.data;
    const note = resolvedUrl !== envUrl ? `  ${DIM}(OLLAMA_BASE_URL=${envUrl} didn't respond — using ${resolvedUrl})${NC}` : "";
    console.log(`  ${GREEN}✓${NC} API reachable at ${resolvedUrl} (${duration}ms)`);
    if (note) console.log(note);
    console.log(`  ${GREEN}✓${NC} Models available: ${modelsData?.models?.length || 0}`);
  } else {
    console.log(`  ${RED}✗${NC} API not responding (tried: ${candidates.join(", ")})`);
    console.log(
      `  ${YELLOW}!${NC} Start with: ${BOLD}ollama serve${NC}  or  ${BOLD}bash scripts/ensure-ollama.sh${NC}`,
    );
    ok = false;
  }

  // 3. Check embedding model
  console.log(`\n${BOLD}[3/7] Checking model: ${modelName}...${NC}`);
  if (modelsData) {
    const models = modelsData.models || [];
    const found = models.some((m) => m.name.includes(modelName));
    if (found) {
      console.log(`  ${GREEN}✓${NC} Model '${modelName}' is available`);
    } else {
      const available = models.map((m) => m.name).join(", ") || "(none)";
      console.log(`  ${YELLOW}!${NC} Model '${modelName}' not found`);
      console.log(`  ${DIM}  Available: ${available}${NC}`);
      console.log(
        `  ${YELLOW}!${NC} Run: ${BOLD}ollama pull ${modelName}${NC}`,
      );
    }
  } else {
    console.log(`  ${YELLOW}!${NC} Skipped (API unreachable)`);
  }

  // 4. Test embedding generation
  console.log(`\n${BOLD}[4/7] Testing embedding generation...${NC}`);
  if (modelsData) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 15000);
      const start = Date.now();
      const response = await fetch(`${resolvedUrl}/api/embed`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          model: modelName,
          input: "th0th diagnostic test",
        }),
      });
      clearTimeout(timeoutId);

      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const data = (await response.json()) as {
        embeddings?: number[][];
        embedding?: number[];
      };
      const duration = Date.now() - start;
      const embedding = data.embeddings?.[0] || data.embedding;
      const dimensions = embedding?.length || 0;

      if (!embedding || dimensions === 0) {
        throw new Error("Empty embedding returned");
      }
      if (embedding.some((v) => isNaN(v) || !isFinite(v))) {
        throw new Error("Embedding contains NaN or Infinity values");
      }

      console.log(`  ${GREEN}✓${NC} Embedding OK!  dimensions=${dimensions}  latency=${duration}ms`);
    } catch (err) {
      console.log(
        `  ${RED}✗${NC} Embedding failed: ${(err as Error).message}`,
      );
      console.log(
        `  ${YELLOW}!${NC} Ensure '${modelName}' is fully pulled.`,
      );
      ok = false;
    }
  } else {
    console.log(`  ${YELLOW}!${NC} Skipped (API unreachable)`);
    ok = false;
  }

  return ok;
}

// ─── PostgreSQL Checks ───────────────────────────────────────────────

async function checkPostgres(): Promise<boolean> {
  const databaseUrl = process.env.DATABASE_URL;

  // 5. Check DATABASE_URL configuration
  console.log(`\n${BOLD}[5/7] Checking PostgreSQL configuration...${NC}`);
  if (!databaseUrl) {
    console.log(`  ${YELLOW}!${NC} DATABASE_URL not set`);
    console.log(`  ${DIM}  PostgreSQL is optional. SQLite will be used as fallback.${NC}`);
    console.log(`  ${DIM}  Set DATABASE_URL in .env to enable PostgreSQL + pgvector.${NC}`);
    return true; // Not an error, PostgreSQL is optional
  }

  const masked = maskDatabaseUrl(databaseUrl);
  console.log(`  ${GREEN}✓${NC} DATABASE_URL configured`);
  console.log(`  ${DIM}  ${masked}${NC}`);

  // 6. Test PostgreSQL connectivity + pgvector
  console.log(`\n${BOLD}[6/7] Testing PostgreSQL connectivity...${NC}`);
  let pgOk = false;
  try {
    // Dynamic import - pg is an optional dependency
    const { default: pg } = (await import("pg")) as any;

    // In WSL2 with mirrored networking, "localhost" may resolve to ::1 (IPv6)
    // while PostgreSQL only listens on 127.0.0.1 (IPv4).
    // Try the original URL first; if it fails, retry with 127.0.0.1.
    const urlsToTry = [databaseUrl];
    if (databaseUrl.includes("localhost")) {
      urlsToTry.push(databaseUrl.replace("localhost", "127.0.0.1"));
    }

    let client: any = null;
    let connectedUrl = databaseUrl;
    for (const url of urlsToTry) {
      try {
        const c = new pg.Client({ connectionString: url, connectionTimeoutMillis: 3000 });
        await c.connect();
        client = c;
        connectedUrl = url;
        break;
      } catch (e: any) {
        if (url === urlsToTry[urlsToTry.length - 1]) throw e;
      }
    }

    if (connectedUrl !== databaseUrl) {
      console.log(`  ${DIM}(DATABASE_URL uses 'localhost' which resolved to IPv6 — connected via 127.0.0.1)${NC}`);
    }

    const start = Date.now();
    // Basic connectivity
    const versionResult = await client.query("SELECT version()");
    const duration = Date.now() - start;
    const pgVersion = (versionResult.rows[0]?.version as string)?.split(" ").slice(0, 2).join(" ") || "unknown";
    console.log(`  ${GREEN}✓${NC} Connected to ${pgVersion} (${duration}ms)`);

    // Check database name
    const dbResult = await client.query("SELECT current_database()");
    console.log(`  ${GREEN}✓${NC} Database: ${dbResult.rows[0]?.current_database}`);

    // Check pgvector extension
    console.log(`\n${BOLD}[7/7] Checking pgvector extension...${NC}`);
    const extResult = await client.query(
      "SELECT extname, extversion FROM pg_extension WHERE extname = 'vector'",
    );

    if (extResult.rows.length > 0) {
      const ext = extResult.rows[0] as { extname: string; extversion: string };
      console.log(`  ${GREEN}✓${NC} pgvector v${ext.extversion} installed`);
    } else {
      // Check if extension is available but not installed
      const availResult = await client.query(
        "SELECT name, default_version FROM pg_available_extensions WHERE name = 'vector'",
      );
      if (availResult.rows.length > 0) {
        const avail = availResult.rows[0] as { name: string; default_version: string };
        console.log(`  ${YELLOW}!${NC} pgvector v${avail.default_version} available but not installed`);
        console.log(`  ${YELLOW}!${NC} Run: ${BOLD}CREATE EXTENSION vector;${NC}`);
      } else {
        console.log(`  ${RED}✗${NC} pgvector extension not available`);
        console.log(`  ${YELLOW}!${NC} Use the pgvector Docker image: ${BOLD}pgvector/pgvector:pg16${NC}`);
      }
    }

    // Check if th0th tables exist (Prisma migrations)
    const tablesResult = await client.query(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename",
    );
    const tables = tablesResult.rows.map((r: { tablename: string }) => r.tablename);
    const expectedTables = ["memories", "memory_edges", "projects", "code_chunks"];
    const foundTables = expectedTables.filter((t) => tables.includes(t));

    if (foundTables.length > 0) {
      console.log(`  ${GREEN}✓${NC} th0th tables found: ${foundTables.join(", ")}`);
    } else if (tables.length > 0) {
      console.log(`  ${YELLOW}!${NC} Database has ${tables.length} tables but no th0th tables`);
      console.log(`  ${YELLOW}!${NC} Run migrations: ${BOLD}cd packages/core && bunx prisma migrate deploy${NC}`);
    } else {
      console.log(`  ${YELLOW}!${NC} Database is empty (no tables)`);
      console.log(`  ${YELLOW}!${NC} Run migrations: ${BOLD}cd packages/core && bunx prisma migrate deploy${NC}`);
    }

    await client.end();
    pgOk = true;
  } catch (err) {
    const message = (err as Error).message;

    if (message.includes("Cannot find module") || message.includes("Cannot find package")) {
      console.log(`  ${YELLOW}!${NC} 'pg' module not installed (optional dependency)`);
      console.log(`  ${DIM}  Install with: bun add pg${NC}`);

      // Fallback: try psql CLI
      console.log(`  ${DIM}  Trying psql CLI as fallback...${NC}`);
      const psqlVersion = await run(["psql", "--version"]);
      if (psqlVersion) {
        const psqlResult = await run(
          ["psql", databaseUrl, "-c", "SELECT 1"],
          5000,
        );
        if (psqlResult) {
          console.log(`  ${GREEN}✓${NC} PostgreSQL reachable via psql`);
          console.log(`\n${BOLD}[7/7] Checking pgvector extension...${NC}`);
          const extCheck = await run(
            ["psql", databaseUrl, "-tAc", "SELECT extversion FROM pg_extension WHERE extname='vector'"],
            5000,
          );
          if (extCheck) {
            console.log(`  ${GREEN}✓${NC} pgvector v${extCheck} installed`);
          } else {
            console.log(`  ${YELLOW}!${NC} pgvector status unknown (query failed or not installed)`);
          }
          pgOk = true;
        } else {
          console.log(`  ${RED}✗${NC} PostgreSQL unreachable via psql`);
        }
      } else {
        console.log(`  ${YELLOW}!${NC} psql not available either. Cannot verify PostgreSQL.`);
        console.log(`\n${BOLD}[7/7] Checking pgvector extension...${NC}`);
        console.log(`  ${YELLOW}!${NC} Skipped (no PostgreSQL client available)`);
      }
    } else if (message.includes("ECONNREFUSED")) {
      console.log(`  ${RED}✗${NC} Connection refused`);
      console.log(`  ${YELLOW}!${NC} Start PostgreSQL: ${BOLD}docker compose up -d postgres${NC}`);
      console.log(`\n${BOLD}[7/7] Checking pgvector extension...${NC}`);
      console.log(`  ${YELLOW}!${NC} Skipped (connection refused)`);
    } else if (message.includes("authentication failed") || message.includes("password")) {
      console.log(`  ${RED}✗${NC} Authentication failed`);
      console.log(`  ${YELLOW}!${NC} Check credentials in DATABASE_URL`);
      console.log(`\n${BOLD}[7/7] Checking pgvector extension...${NC}`);
      console.log(`  ${YELLOW}!${NC} Skipped (auth failed)`);
    } else {
      console.log(`  ${RED}✗${NC} ${message}`);
      console.log(`\n${BOLD}[7/7] Checking pgvector extension...${NC}`);
      console.log(`  ${YELLOW}!${NC} Skipped (connection error)`);
    }
  }

  return pgOk;
}

// ─── Main ────────────────────────────────────────────────────────────

const ollamaOk = await checkOllama();
const pgOk = await checkPostgres();

// Summary
console.log(
  `\n${BOLD}╔═══════════════════════════════════════════════════════════════╗${NC}`,
);
console.log(
  `${BOLD}║                    Diagnosis Summary                          ║${NC}`,
);
console.log(
  `${BOLD}╚═══════════════════════════════════════════════════════════════╝${NC}`,
);
console.log(
  `  Ollama:     ${ollamaOk ? `${GREEN}OK${NC}` : `${RED}FAILED${NC}`}`,
);
console.log(
  `  PostgreSQL: ${pgOk ? `${GREEN}OK${NC}` : `${RED}FAILED${NC}`}  ${!process.env.DATABASE_URL ? `${DIM}(not configured)${NC}` : ""}`,
);
console.log("");

const allOk = ollamaOk && pgOk;
process.exit(allOk ? 0 : 1);
