/**
 * Authentication Middleware
 *
 * Valida API Key no header X-API-Key.
 * Rotas /health e /swagger são públicas.
 */

import { Elysia } from "elysia";

const PUBLIC_PATHS = ["/health", "/swagger", "/swagger/json"];

export const authMiddleware = new Elysia({ name: "auth" }).onBeforeHandle(
  { as: "global" },
  ({ headers, path, set }) => {
    // Skip auth for public routes
    if (PUBLIC_PATHS.some((p) => path.startsWith(p))) {
      return;
    }

    const apiKey = process.env.TH0TH_API_KEY;

    // If no API key configured, allow all requests (dev mode)
    if (!apiKey) {
      return;
    }

    const providedKey = headers["x-api-key"];

    if (!providedKey || providedKey !== apiKey) {
      set.status = 401;
      return {
        success: false,
        error: "Unauthorized: Invalid or missing API key",
      };
    }

    // Auth successful
    return;
  },
);
