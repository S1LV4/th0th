import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Elysia } from "elysia";
import { authMiddleware } from "./auth.js";

function buildApp() {
  return new Elysia()
    .use(authMiddleware)
    .get("/health", () => ({ status: "ok" }))
    .get("/api/v1/protected", () => ({ data: "secret" }));
}

describe("authMiddleware", () => {
  const saved = process.env.TH0TH_API_KEY;

  afterEach(() => {
    if (saved === undefined) delete process.env.TH0TH_API_KEY;
    else process.env.TH0TH_API_KEY = saved;
  });

  // ── dev mode (no key configured) ─────────────────────────────
  describe("dev mode — TH0TH_API_KEY not set", () => {
    beforeEach(() => { delete process.env.TH0TH_API_KEY; });

    test("allows requests without header", async () => {
      const app = buildApp();
      const res = await app.handle(new Request("http://localhost/api/v1/protected"));
      expect(res.status).toBe(200);
    });

    test("allows /health without header", async () => {
      const app = buildApp();
      const res = await app.handle(new Request("http://localhost/health"));
      expect(res.status).toBe(200);
    });
  });

  // ── production mode (key configured) ─────────────────────────
  describe("production mode — TH0TH_API_KEY=test-key", () => {
    beforeEach(() => { process.env.TH0TH_API_KEY = "test-key"; });

    test("returns 401 with no header", async () => {
      const app = buildApp();
      const res = await app.handle(new Request("http://localhost/api/v1/protected"));
      expect(res.status).toBe(401);
      const body = await res.json() as { success: boolean };
      expect(body.success).toBe(false);
    });

    test("returns 401 with wrong key", async () => {
      const app = buildApp();
      const res = await app.handle(
        new Request("http://localhost/api/v1/protected", {
          headers: { "x-api-key": "wrong-key" },
        }),
      );
      expect(res.status).toBe(401);
    });

    test("returns 200 with correct key", async () => {
      const app = buildApp();
      const res = await app.handle(
        new Request("http://localhost/api/v1/protected", {
          headers: { "x-api-key": "test-key" },
        }),
      );
      expect(res.status).toBe(200);
      const body = await res.json() as { data: string };
      expect(body.data).toBe("secret");
    });

    test("/health is public — no key needed", async () => {
      const app = buildApp();
      const res = await app.handle(new Request("http://localhost/health"));
      expect(res.status).toBe(200);
    });

    test("/swagger is public — no key needed", async () => {
      const app = buildApp().get("/swagger", () => "docs");
      const res = await app.handle(new Request("http://localhost/swagger"));
      expect(res.status).toBe(200);
    });
  });
});
