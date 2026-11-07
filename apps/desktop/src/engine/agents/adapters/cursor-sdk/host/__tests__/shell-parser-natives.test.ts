// Regression (Mac, 2026-11-07): every Cursor session logged "shell-parser:
// tree-sitter natives are unavailable in this artifact". @cursor/sdk looks for
// its platform package only above the host script and the runtime executable;
// pnpm and the packaged app keep it beside the SDK. Without the natives, shell
// command analysis fails, and a team's admin command denylist then blocks every
// shell command. The host now points the SDK at the package beside it.
//
// Drives the REAL cursor-host.cjs against this checkout's installed SDK.

import { afterEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HOST = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "cursor-host.cjs");
const require = createRequire(import.meta.url);
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

/** The host's stderr up to its ready frame. */
async function startupDiagnostics(env: Record<string, string>): Promise<string> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "zeros-cursor-parser-"));
  cleanup.push(() => rm(cwd, { recursive: true, force: true }));
  const child = spawn(process.execPath, [HOST], {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      ZEROS_CURSOR_SDK_ENTRY: "",
      ZEROS_CURSOR_STATE_ROOT: path.join(cwd, "state"),
      CURSOR_TREE_SITTER_VENDOR_DIR: "",
      ...env,
    },
  });
  cleanup.push(async () => {
    child.kill("SIGKILL");
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => (stderr += chunk));
  child.stdout.setEncoding("utf8");
  await new Promise<void>((resolve, reject) => {
    let stdout = "";
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.split("\n").some((line) => line.trim() && JSON.parse(line).k === "ready")) resolve();
    });
    child.once("exit", (code) => reject(new Error(`host exited ${code}: ${stderr}`)));
  });
  return stderr;
}

describe("Cursor host shell parser natives", () => {
  it("hands the SDK the tree-sitter natives installed beside it", async () => {
    const stderr = await startupDiagnostics({ ZEROS_CURSOR_TRANSPORT_DEBUG: "1" });
    expect(stderr).not.toContain("tree-sitter natives are unavailable");
    const vendor = stderr.match(/\[cursor-host\] shell-parser: tree-sitter natives at (.+)\n/)?.[1];
    if (!vendor) throw new Error(`no shell parser natives reported:\n${stderr}`);
    expect(path.isAbsolute(vendor)).toBe(true);
    // The same natives the SDK loads parse an agent's computer use chain.
    const Parser = require(path.join(vendor, "tree-sitter"));
    const parser = new Parser();
    parser.setLanguage(require(path.join(vendor, "tree-sitter-bash")));
    const tree = parser.parse('zeros computer open --app "Google Chrome" https://cursor.com && zeros computer shot');
    expect(tree.rootNode.hasError).toBe(false);
    // An SDK upgrade that stops reading this override must fail here.
    const sdk = await readFile(require.resolve("@cursor/sdk"), "utf8");
    expect(sdk).toContain("process.env.CURSOR_TREE_SITTER_VENDOR_DIR");
  }, 30_000);

  it("keeps an operator's own natives directory", async () => {
    const stderr = await startupDiagnostics({
      ZEROS_CURSOR_TRANSPORT_DEBUG: "1",
      CURSOR_TREE_SITTER_VENDOR_DIR: "/opt/cursor-natives",
    });
    expect(stderr).toContain("[cursor-host] shell-parser: tree-sitter natives at /opt/cursor-natives\n");
  }, 30_000);
});
