#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, copyFile, mkdir, realpath, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(script), "..");

/** Search is a product/provider asset, independent of execution posture. Keep
 * exact pinned bytes and owner-write for Squirrel.Mac's quarantine removal.
 * @param {{source?: string, output?: string}} [options]
 */
export async function stageRipgrep(options = {}) {
  const source = await realpath(options.source ?? (await import("@vscode/ripgrep")).rgPath);
  const metadata = await stat(source);
  if (!metadata.isFile() || (process.platform !== "win32" && (metadata.mode & 0o111) === 0)) {
    throw new Error("Pinned ripgrep is not a regular executable");
  }
  const output = options.output ?? path.join(root, "binaries", process.platform === "win32" ? "rg.exe" : "rg");
  await mkdir(path.dirname(output), { recursive: true });
  const staged = `${output}.tmp-${randomUUID()}`;
  try {
    await copyFile(source, staged, constants.COPYFILE_EXCL);
    await chmod(staged, 0o755);
    await rename(staged, output);
  } finally {
    await rm(staged, { force: true });
  }
  return output;
}

if (process.argv[1] && path.resolve(process.argv[1]) === script) await stageRipgrep();
