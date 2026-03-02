#!/usr/bin/env bun
/**
 * version-sync.ts
 * Syncs all package/app versions to match the root package.json version.
 * Usage: bun run version:sync
 */

import { readdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

const root = join(import.meta.dir, "..");
const rootPkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const version: string = rootPkg.version;

const targets = [
  ...readdirSync(join(root, "packages")).map((d) =>
    join(root, "packages", d, "package.json")
  ),
  ...readdirSync(join(root, "apps")).map((d) =>
    join(root, "apps", d, "package.json")
  ),
];

for (const pkgPath of targets) {
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    if (pkg.version === undefined) continue;
    pkg.version = version;
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
    console.log(`  ✓ ${pkgPath.replace(root + "/", "")} → ${version}`);
  } catch {
    // skip missing paths
  }
}

console.log(`\nAll packages synced to ${version}`);
