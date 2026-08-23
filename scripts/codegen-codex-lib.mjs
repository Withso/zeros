import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Build the argument vectors for the pinned Codex CLI's current app-server
 * exporters. TypeScript and JSON Schema became separate subcommands in
 * rust-v0.149.0, so both must succeed before Zeros publishes new bindings.
 */
export function codexAppServerExportArgs(outDir) {
  const base = ["app-server"];
  return [
    [...base, "generate-ts", "--out", outDir, "--experimental"],
    [...base, "generate-json-schema", "--out", outDir, "--experimental"],
  ];
}

/**
 * Populate a sibling directory and publish it only after every generation step
 * succeeds. A failed exporter therefore cannot erase the committed fallback
 * bindings used on machines without Rust or network access.
 */
export function replaceDirectoryTransactionally(destination, populate) {
  const staging = `${destination}.next`;
  const previous = `${destination}.previous`;
  mkdirSync(dirname(destination), { recursive: true });

  // Recover from a process that stopped between the two renames. If the new
  // destination exists, an old backup is merely stale; otherwise it is the
  // last known-good tree and must be restored before another attempt.
  if (existsSync(previous)) {
    if (existsSync(destination)) {
      rmSync(previous, { recursive: true, force: true });
    } else {
      renameSync(previous, destination);
    }
  }
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });

  try {
    populate(staging);
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }

  try {
    if (existsSync(destination)) renameSync(destination, previous);
    renameSync(staging, destination);
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    if (!existsSync(destination) && existsSync(previous)) {
      renameSync(previous, destination);
    }
    throw error;
  }

  rmSync(previous, { recursive: true, force: true });
}
