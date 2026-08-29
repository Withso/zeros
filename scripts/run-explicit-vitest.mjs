#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;

function inside(candidate, parent) {
  const relative = path.relative(parent, candidate);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

/** Vitest treats a missing positional path as an empty filter and exits zero.
 * Validate the named matrix before invoking it so deleting or renaming a gate
 * cannot silently reduce containment coverage. */
export function validateExplicitTestFiles(
  files,
  repositoryRoot = process.cwd(),
) {
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error("at least one explicit Vitest file is required");
  }
  const lexicalRoot = path.resolve(repositoryRoot);
  const physicalRoot = realpathSync(lexicalRoot);
  const seen = new Set();
  return files.map((file) => {
    if (
      typeof file !== "string" ||
      file.includes("\0") ||
      path.isAbsolute(file) ||
      !TEST_FILE.test(file)
    ) {
      throw new Error(`invalid explicit Vitest file: ${String(file)}`);
    }
    const lexicalFile = path.resolve(lexicalRoot, file);
    if (!inside(lexicalFile, lexicalRoot)) {
      throw new Error(`explicit Vitest file escapes the repository: ${file}`);
    }
    let metadata;
    try {
      metadata = lstatSync(lexicalFile);
    } catch (error) {
      if (error?.code === "ENOENT") {
        throw new Error(`missing explicit Vitest file: ${file}`);
      }
      throw error;
    }
    const relative = path.relative(lexicalRoot, lexicalFile);
    const expectedPhysical = path.resolve(physicalRoot, relative);
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      realpathSync(lexicalFile) !== expectedPhysical
    ) {
      throw new Error(
        `explicit Vitest entry is not one physical regular file: ${file}`,
      );
    }
    const normalized = relative.split(path.sep).join("/");
    if (seen.has(normalized)) {
      throw new Error(`duplicate explicit Vitest file: ${normalized}`);
    }
    seen.add(normalized);
    return normalized;
  });
}

export function runExplicitVitest(files, repositoryRoot = process.cwd()) {
  const validated = validateExplicitTestFiles(files, repositoryRoot);
  const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  const result = spawnSync(
    pnpm,
    ["exec", "vitest", "run", "--config", "vitest.config.ts", ...validated],
    { cwd: repositoryRoot, stdio: "inherit" },
  );
  if (result.error) throw result.error;
  return result.status ?? 1;
}

const invokedPath = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : "";
if (invokedPath === import.meta.url) {
  try {
    process.exitCode = runExplicitVitest(process.argv.slice(2));
  } catch (error) {
    const script = path.relative(process.cwd(), fileURLToPath(import.meta.url));
    console.error(
      `✖ ${script} — ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}
