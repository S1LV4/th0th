/**
 * Environment Configuration Loader
 *
 * MUST be imported first before any other modules
 * to ensure .env variables are loaded before config initialization.
 *
 * Walks up from cwd to find the nearest .env file,
 * supporting monorepo layouts where packages run from subdirectories.
 */

import { config as dotenvConfig } from "dotenv";
import { existsSync } from "fs";
import { resolve, dirname } from "path";

function findEnvFile(): string | undefined {
  let dir = process.cwd();

  while (true) {
    const envPath = resolve(dir, ".env");
    if (existsSync(envPath)) {
      return envPath;
    }
    const parent = dirname(dir);
    if (parent === dir) break; // reached filesystem root
    dir = parent;
  }

  return undefined;
}

// Load .env file - walk up directories to find it (monorepo support)
const envPath = findEnvFile();
dotenvConfig({ path: envPath });

// Export a dummy value to ensure this module is imported
export const ENV_LOADED = true;
