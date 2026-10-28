import { mkdtempSync, rmSync, symlinkSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, expect, it } from "vitest";
import { readSettingsFile } from "../../settings/files";

const roots: string[] = [];
const temporary = () => { const dir = mkdtempSync(path.join(tmpdir(), "zeros-config-safe-")); roots.push(dir); return dir; };
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

it("refuses special settings files without blocking the engine", () => {
  const file = path.join(temporary(), "settings.toml");
  expect(spawnSync("mkfifo", [file]).status).toBe(0);
  // The root package uses CommonJS. Use tsx's matching loader on Node 22
  // too, so a missing ESM named export cannot mask the FIFO behavior.
  const code = `const { readSettingsFile } = require(${JSON.stringify(path.resolve("apps/desktop/src/engine/settings/files.ts"))});
    const result = readSettingsFile(${JSON.stringify(file)}); process.exit(result.error ? 0 : 1);`;
  const result = spawnSync(process.execPath, ["--require", "tsx/cjs", "-e", code], {
    timeout: 5_000, encoding: "utf8", maxBuffer: 64 * 1024,
  });
  expect(result.status, `reader must reject rather than wait for a FIFO writer: ${result.stderr}`).toBe(0);
});

it("refuses oversized settings and descendant symlinks", () => {
  const root = temporary();
  const outside = temporary();
  writeFileSync(path.join(outside, "settings.toml"), '[scripts]\nrun="outside"\n');
  symlinkSync(outside, path.join(root, ".zeros"));
  expect(readSettingsFile(path.join(root, ".zeros/settings.toml")).doc).toEqual({});
  mkdirSync(path.join(root, "real"));
  const file = path.join(root, "real/settings.toml");
  writeFileSync(file, "#".repeat(4 * 1024 * 1024 + 1));
  expect(readSettingsFile(file).error).toBeTruthy();
});
