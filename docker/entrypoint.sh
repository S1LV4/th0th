#!/bin/sh
# ============================================
# th0th API - Container Entrypoint
# ============================================
# Runs Prisma migrations before starting the API.
# Safe to run on every startup: migrate deploy is idempotent.
# ============================================

set -e

# Only run migrations when a PostgreSQL DATABASE_URL is present.
# SQLite users skip this step entirely.
if [ -n "$DATABASE_URL" ] && echo "$DATABASE_URL" | grep -q "^postgres"; then
  echo "[entrypoint] Running database migrations..."
  (cd /app/packages/core && bunx prisma migrate deploy)
  echo "[entrypoint] Migrations complete."
else
  echo "[entrypoint] No PostgreSQL DATABASE_URL detected, skipping migrations."
fi

echo "[entrypoint] Starting th0th API..."
exec "$@"
