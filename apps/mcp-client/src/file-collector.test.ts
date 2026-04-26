import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { collectFiles } from "./file-collector.js";

let tmpDir: string;

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "th0th-collector-test-"));

  // Supported files
  await fs.writeFile(path.join(tmpDir, "index.ts"), 'export const x = 1;');
  await fs.writeFile(path.join(tmpDir, "app.js"), 'console.log("hello")');
  await fs.writeFile(path.join(tmpDir, "component.tsx"), 'export default () => null;');

  // Unsupported file (should be ignored)
  await fs.writeFile(path.join(tmpDir, "style.css"), 'body {}');
  await fs.writeFile(path.join(tmpDir, "README.md"), '# readme');

  // Nested supported file
  await fs.mkdir(path.join(tmpDir, "src"), { recursive: true });
  await fs.writeFile(path.join(tmpDir, "src", "utils.ts"), 'export function noop() {}');

  // node_modules directory (should be skipped)
  await fs.mkdir(path.join(tmpDir, "node_modules", "pkg"), { recursive: true });
  await fs.writeFile(path.join(tmpDir, "node_modules", "pkg", "index.ts"), 'export {}');

  // dist directory (should be skipped)
  await fs.mkdir(path.join(tmpDir, "dist"), { recursive: true });
  await fs.writeFile(path.join(tmpDir, "dist", "bundle.js"), 'var x=1;');
});

afterAll(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("collectFiles", () => {
  it("collects supported file types", async () => {
    const files = await collectFiles(tmpDir);
    const paths = files.map((f) => f.relativePath);
    expect(paths).toContain("index.ts");
    expect(paths).toContain("app.js");
    expect(paths).toContain("component.tsx");
    expect(paths).toContain(path.join("src", "utils.ts"));
  });

  it("excludes unsupported extensions", async () => {
    const files = await collectFiles(tmpDir);
    const paths = files.map((f) => f.relativePath);
    expect(paths).not.toContain("style.css");
    expect(paths).not.toContain("README.md");
  });

  it("skips node_modules and dist", async () => {
    const files = await collectFiles(tmpDir);
    const paths = files.map((f) => f.relativePath);
    expect(paths.some((p) => p.includes("node_modules"))).toBe(false);
    expect(paths.some((p) => p.includes("dist"))).toBe(false);
  });

  it("includes file content", async () => {
    const files = await collectFiles(tmpDir);
    const indexFile = files.find((f) => f.relativePath === "index.ts");
    expect(indexFile).toBeDefined();
    expect(indexFile!.content).toBe('export const x = 1;');
  });

  it("returns empty array for non-existent directory", async () => {
    const files = await collectFiles("/tmp/__th0th_nonexistent_dir_xyz__");
    expect(files).toEqual([]);
  });
});
