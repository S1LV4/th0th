/**
 * Unit tests — getPrismaClient() missing-adapter fallback (Issue #25 fix)
 *
 * Before the fix, both catch blocks in getPrismaClient() called
 * `new PrismaClient()` without an adapter. When the `driverAdapters`
 * preview feature is enabled in schema.prisma, Prisma rejects this and
 * throws `PrismaClientInitializationError` — a confusing internal error
 * with no actionable guidance.
 *
 * After the fix, both catch blocks throw a plain `Error` with a clear
 * message telling the user exactly which package to install.
 *
 * ── Mocking strategy ─────────────────────────────────────────────────────
 * Rather than fighting Bun's workspace-level module-mock cache behaviour
 * (mock.module() cache keys don't reliably match require() resolution paths
 * across workspace symlinks), the production code exposes a thin `_adapters`
 * object whose loader methods are the sole callsites for require().  Tests
 * override individual loaders to throw, simulating a missing package, and
 * restore them in afterEach.
 *
 * `_resetPrismaForTesting()` clears the module-level singleton so each test
 * starts with a fresh initialisation path.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";

// No @th0th-ai/shared mock needed: the adapter loaders throw before
// config.get() or logger are ever reached in both SQLite and PostgreSQL paths.
import {
  getPrismaClient,
  _adapters,
  _resetPrismaForTesting,
} from "../services/query/prisma-client.js";

// ── Adapter override helpers ───────────────────────────────────────────────
// Save real loaders so they can be restored after each test.
const realLoadPg = _adapters.loadPg.bind(_adapters);
const realLoadPrismaPg = _adapters.loadPrismaPg.bind(_adapters);
const realLoadPrismaBunSqlite = _adapters.loadPrismaBunSqlite.bind(_adapters);

function failPrismaBunSqlite() {
  _adapters.loadPrismaBunSqlite = () => {
    throw new Error("Cannot find module 'prisma-adapter-bun-sqlite'");
  };
}

function failPrismaPg() {
  // Throw at the first pg-related load so we never attempt a real connection.
  _adapters.loadPg = () => {
    throw new Error("Cannot find module 'pg'");
  };
}

function restoreAdapters() {
  _adapters.loadPg = realLoadPg;
  _adapters.loadPrismaPg = realLoadPrismaPg;
  _adapters.loadPrismaBunSqlite = realLoadPrismaBunSqlite;
}

// ── Helper ─────────────────────────────────────────────────────────────────
function captureError(): Error {
  try {
    getPrismaClient();
    return new Error("getPrismaClient() did not throw");
  } catch (e) {
    return e as Error;
  }
}

// ══════════════════════════════════════════════════════════════════════════
describe("getPrismaClient() — missing adapter fallback (Issue #25)", () => {
  const savedDatabaseUrl = process.env.DATABASE_URL;

  afterEach(() => {
    // Always restore adapters and reset singleton so tests are independent.
    restoreAdapters();
    _resetPrismaForTesting();

    if (savedDatabaseUrl !== undefined) {
      process.env.DATABASE_URL = savedDatabaseUrl;
    } else {
      delete process.env.DATABASE_URL;
    }
  });

  // ── SQLite mode (DATABASE_URL not set) ────────────────────────────────
  describe("SQLite mode — prisma-adapter-bun-sqlite missing", () => {
    beforeEach(() => {
      failPrismaBunSqlite();
      delete process.env.DATABASE_URL;
    });

    test("throws an Error when the adapter cannot be loaded", () => {
      expect(() => getPrismaClient()).toThrow(Error);
    });

    test("error message identifies the missing package", () => {
      const err = captureError();
      expect(err.message).toContain("prisma-adapter-bun-sqlite");
    });

    test("error message contains an actionable install command", () => {
      const err = captureError();
      expect(err.message).toContain("bun add prisma-adapter-bun-sqlite");
    });

    test("does not surface a PrismaClientInitializationError", () => {
      const err = captureError();
      expect(err.message).not.toContain("PrismaClientInitializationError");
      expect(err.message).not.toContain("PrismaClientOptions");
    });

    test("prismaInstance is never set — second call also throws", () => {
      const err1 = captureError();
      const err2 = captureError();
      expect(err1.message).toContain("prisma-adapter-bun-sqlite");
      expect(err2.message).toContain("prisma-adapter-bun-sqlite");
    });
  });

  // ── PostgreSQL mode (DATABASE_URL = postgres://...) ───────────────────
  describe("PostgreSQL mode — pg / @prisma/adapter-pg missing", () => {
    beforeEach(() => {
      failPrismaPg();
      process.env.DATABASE_URL =
        "postgresql://th0th:th0th_password@localhost:5432/th0th";
    });

    test("throws an Error when the adapter cannot be loaded", () => {
      expect(() => getPrismaClient()).toThrow(Error);
    });

    test("error message identifies the missing packages", () => {
      const err = captureError();
      expect(err.message).toContain("pg");
      expect(err.message).toContain("@prisma/adapter-pg");
    });

    test("error message contains an actionable install command", () => {
      const err = captureError();
      expect(err.message).toContain("bun add pg @prisma/adapter-pg");
    });

    test("does not surface a PrismaClientInitializationError", () => {
      const err = captureError();
      expect(err.message).not.toContain("PrismaClientInitializationError");
      expect(err.message).not.toContain("PrismaClientOptions");
    });

    test("prismaInstance is never set — second call also throws", () => {
      const err1 = captureError();
      const err2 = captureError();
      expect(err1.message).toContain("pg");
      expect(err2.message).toContain("pg");
    });
  });
});
