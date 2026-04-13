/**
 * ETL Stage 3 — Resolve
 *
 * Resolves import specifiers to concrete relative file paths within the project.
 * Fills in ResolvedImport.resolvedPath and RawSymbol.fqn for each ParsedFile.
 *
 * Resolution strategy (TS/JS):
 *   1. Relative imports (./  ../) → path.resolve + extension probing
 *   2. Workspace aliases (@th0th-ai/core, etc.) → read tsconfig.json paths
 *   3. Everything else → external (npm), resolvedPath = null
 */

import path from "path";
import fs from "fs";
import { logger } from "@th0th-ai/shared";
import type {
  EtlStageContext,
  ParsedFile,
  ResolvedFile,
  ResolvedImport,
  RawImport,
} from "../stage-context.js";

const TS_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", "/index.ts", "/index.js"];

interface TsPathAlias {
  prefix: string;
  targets: string[];
  packagePath?: string;
}

interface MonorepoPackage {
  path: string;
  relativePath: string;
  aliases: TsPathAlias[];
}

export class ResolveStage {
  async run(ctx: EtlStageContext, files: ParsedFile[]): Promise<ResolvedFile[]> {
    const t0 = performance.now();

    ctx.emit({
      type: "stage_start",
      stage: "resolve",
      payload: { total: files.length },
      timestamp: Date.now(),
    });

    // Build lookup set of all known relative paths (for O(1) membership checks)
    const knownRelPaths = new Set(files.map((f) => f.file.relativePath));

    // Parse tsconfig.json compilerOptions.paths for workspace alias resolution
    const rootAliases = this.loadTsConfigPaths(ctx.projectPath);
    
    // Detect monorepo packages and load their tsconfigs
    const monorepoPackages = this.detectMonorepoPackages(ctx.projectPath, files);

    const resolved: ResolvedFile[] = [];
    let processed = 0;

    for (const parsedFile of files) {
      const resolvedFile = this.resolveFile(
        parsedFile,
        ctx.projectPath,
        knownRelPaths,
        rootAliases,
        monorepoPackages,
      );
      resolved.push(resolvedFile);
      processed++;

      if (processed % 50 === 0) {
        ctx.emit({
          type: "progress",
          stage: "resolve",
          payload: {
            current: processed,
            total: files.length,
            percentage: Math.round((processed / files.length) * 100),
          },
          timestamp: Date.now(),
        });
      }
    }

    const durationMs = Math.round(performance.now() - t0);

    ctx.emit({
      type: "stage_end",
      stage: "resolve",
      payload: { total: resolved.length, durationMs },
      timestamp: Date.now(),
    });

    logger.info("ETL Resolve complete", { projectId: ctx.projectId, total: resolved.length, durationMs });

    return resolved;
  }

  private resolveFile(
    parsed: ParsedFile,
    projectPath: string,
    knownRelPaths: Set<string>,
    rootAliases: TsPathAlias[],
    monorepoPackages: MonorepoPackage[],
  ): ResolvedFile {
    const fromDir = path.dirname(path.join(projectPath, parsed.file.relativePath));

    // Determine which package this file belongs to
    const packageAliases = this.getPackageAliases(parsed.file.relativePath, monorepoPackages);
    
    // Merge package-specific aliases with root aliases (package aliases take precedence)
    const allAliases = [...packageAliases, ...rootAliases];

    // Resolve imports
    const resolvedImports: ResolvedImport[] = parsed.rawImports.map((raw) => {
      const result = this.resolveSpecifier(raw.specifier, fromDir, projectPath, knownRelPaths, allAliases);
      return { raw, ...result };
    });

    // Fill FQN for each symbol: '{relativePath}#{symbolName}'
    const symbolsWithFqn = parsed.symbols.map((sym) => ({
      ...sym,
      fqn: `${parsed.file.relativePath}#${sym.name}`,
    }));

    return {
      ...parsed,
      symbols: symbolsWithFqn,
      resolvedImports,
    };
  }

  private resolveSpecifier(
    specifier: string,
    fromDir: string,
    projectPath: string,
    knownRelPaths: Set<string>,
    aliases: TsPathAlias[],
  ): { resolvedPath: string | null; external: boolean } {
    // 1. Relative imports
    if (specifier.startsWith("./") || specifier.startsWith("../")) {
      const resolved = this.probeExtensions(
        path.resolve(fromDir, specifier),
        projectPath,
        knownRelPaths,
      );
      return { resolvedPath: resolved, external: false };
    }

    // 2. Workspace alias resolution
    for (const alias of aliases) {
      if (specifier === alias.prefix || specifier.startsWith(alias.prefix + "/")) {
        const suffix = specifier.slice(alias.prefix.length);
        
        for (const target of alias.targets) {
          const cleanTarget = target.replace(/\/\*$/, "");
          
          // If alias has a packagePath, resolve relative to that package
          const basePath = alias.packagePath 
            ? path.join(projectPath, alias.packagePath)
            : projectPath;
            
          const absPath = path.join(basePath, cleanTarget + suffix);
          const resolved = this.probeExtensions(absPath, projectPath, knownRelPaths);
          if (resolved) return { resolvedPath: resolved, external: false };
        }
      }
    }

    // 3. External package
    return { resolvedPath: null, external: true };
  }

  /**
   * Tries the path as-is, then with common TS/JS extensions and /index variants.
   * Returns the relative path if found in knownRelPaths, or null.
   */
  private probeExtensions(
    absPath: string,
    projectPath: string,
    knownRelPaths: Set<string>,
  ): string | null {
    const candidates = [
      absPath,
      ...TS_EXTENSIONS.map((ext) => absPath + ext),
      ...TS_EXTENSIONS.map((ext) => absPath.replace(/\.[^.]+$/, ext)),
    ];

    for (const candidate of candidates) {
      const rel = path.relative(projectPath, candidate).replace(/\\/g, "/");
      if (knownRelPaths.has(rel)) return rel;
    }

    return null;
  }

  /**
   * Parse tsconfig.json compilerOptions.paths into a flat alias list.
   * Handles standard monorepo setups like { "@th0th-ai/core/*": ["packages/core/src/*"] }.
   */
  private loadTsConfigPaths(projectPath: string, packageBase?: string): TsPathAlias[] {
    const aliases: TsPathAlias[] = [];
    const tsconfigPath = path.join(projectPath, "tsconfig.json");

    try {
      const raw = fs.readFileSync(tsconfigPath, "utf-8");
      // Strip JSON comments (tsconfig allows them)
      const stripped = raw.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
      const tsconfig = JSON.parse(stripped);
      const paths: Record<string, string[]> = tsconfig?.compilerOptions?.paths ?? {};

      for (const [alias, targets] of Object.entries(paths)) {
        // "@th0th-ai/core/*" → prefix "@th0th-ai/core"
        const prefix = alias.replace(/\/\*$/, "");
        aliases.push({ 
          prefix, 
          targets,
          packagePath: packageBase,
        });
      }
    } catch {
      // No tsconfig or parse error — silently skip alias resolution
    }

    return aliases;
  }

  /**
   * Detect monorepo packages by scanning for tsconfig.json files in common locations.
   * Supports: packages/*, apps/*, and workspace definitions in package.json
   */
  private detectMonorepoPackages(projectPath: string, files: ParsedFile[]): MonorepoPackage[] {
    const packages: MonorepoPackage[] = [];
    const packagePaths = new Set<string>();

    // Extract unique package directories from file paths
    for (const file of files) {
      const parts = file.file.relativePath.split("/");
      
      // Check for packages/* or apps/* pattern
      for (let i = 0; i < parts.length - 1; i++) {
        if ((parts[i] === "packages" || parts[i] === "apps") && parts[i + 1]) {
          const packageRelPath = parts.slice(0, i + 2).join("/");
          packagePaths.add(packageRelPath);
          break;
        }
      }
    }

    // Load tsconfig for each detected package
    for (const packageRelPath of packagePaths) {
      const absPackagePath = path.join(projectPath, packageRelPath);
      const aliases = this.loadTsConfigPaths(absPackagePath, packageRelPath);
      
      if (aliases.length > 0) {
        packages.push({
          path: absPackagePath,
          relativePath: packageRelPath,
          aliases,
        });
      }
    }

    if (packages.length > 0) {
      logger.info("Detected monorepo packages", { 
        projectPath, 
        packageCount: packages.length,
        packages: packages.map(p => p.relativePath),
      });
    }

    return packages;
  }

  /**
   * Get aliases for the package that contains the given file.
   */
  private getPackageAliases(filePath: string, packages: MonorepoPackage[]): TsPathAlias[] {
    for (const pkg of packages) {
      if (filePath.startsWith(pkg.relativePath + "/") || filePath.startsWith(pkg.relativePath)) {
        return pkg.aliases;
      }
    }
    return [];
  }
}
