import { spawnSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildNativeProduction } from "../design-native-production.mjs";
import { stageNativeEngineBuild } from "../design-native-run.mjs";

const repo = path.resolve(import.meta.dirname, "../..");
const pinned = /^\s+bun-version:\s*(\S+)\s*$/m
  .exec(fs.readFileSync(path.join(repo, ".github/workflows/release.yml"), "utf8"))?.[1] ?? "";
const engineBinary = /^zeros-engine-/;

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "zeros-build-sidecar-"));
  // A stand-in Bun: it reports FAKE_BUN_VERSION and writes the --outfile.
  fs.mkdirSync(path.join(root, "bin"));
  fs.writeFileSync(path.join(root, "bin/bun"), [
    "#!/bin/sh",
    'if [ "$1" = "--version" ]; then echo "$FAKE_BUN_VERSION"; exit 0; fi',
    'while [ $# -gt 0 ]; do if [ "$1" = "--outfile" ]; then printf engine > "$2"; fi; shift; done',
    "",
  ].join("\n"), { mode: 0o755 });
  // build-sidecar.mjs builds only on macOS. Report darwin so Linux reaches its Bun check.
  fs.writeFileSync(path.join(root, "darwin.mjs"), 'Object.defineProperty(process, "platform", { value: "darwin" });\n');
});
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

function buildSidecar(script: string, bunVersion: string, extra: Record<string, string> = {}) {
  const env: NodeJS.ProcessEnv = { ...process.env, FAKE_BUN_VERSION: bunVersion, TMPDIR: root,
    PATH: `${path.join(root, "bin")}${path.delimiter}${process.env.PATH ?? ""}` };
  delete env.ZEROS_SIDECAR_ANY_BUN;
  return spawnSync(process.execPath, ["--import", pathToFileURL(path.join(root, "darwin.mjs")).href, script],
    { encoding: "utf8", env: { ...env, ...extra } });
}

describe("a staged sidecar build", () => {
  it("builds native qualification's engine only with the release pin's Bun", () => {
    expect(pinned).toMatch(/^\d+\.\d+\.\d+$/);
    const stage = stageNativeEngineBuild(repo, root);
    const script = path.join(stage, "scripts/build-sidecar.mjs");

    const newer = buildSidecar(script, "9.9.9");
    expect(newer.stderr).toContain(`bun 9.9.9 differs from the release pin ${pinned}`);
    expect(newer.stderr).toContain(`curl -fsSL https://bun.sh/install | bash -s "bun-v${pinned}"`);
    expect(newer.status).toBe(1);
    expect(buildSidecar(script, "9.9.9", { ZEROS_SIDECAR_ANY_BUN: "yes" }).status).toBe(1);
    expect(fs.existsSync(path.join(stage, "binaries"))).toBe(false);

    const built = buildSidecar(script, pinned);
    expect(built.stdout).toContain("[build-sidecar] wrote");
    expect(built.status).toBe(0);
    expect(fs.readdirSync(path.join(stage, "binaries"))).toEqual([expect.stringMatching(engineBinary)]);
    expect(buildSidecar(script, "9.9.9", { ZEROS_SIDECAR_ANY_BUN: "1" }).status).toBe(0);
  });

  it("builds the production bench's engine only with the release pin's Bun", async () => {
    const disk = await fsp.statfs(root);
    const statfs = vi.spyOn(fsp, "statfs").mockResolvedValue({ ...disk, bavail: Math.ceil(8 * 1024 ** 3 / disk.bsize) });
    const afterEngine = new Error("stop after the engine build");
    const run = vi.fn(async (_command: string, argv: string[]) => {
      if (!argv[0]?.endsWith("/scripts/build-sidecar.mjs")) throw afterEngine;
      const result = buildSidecar(argv[0], pinned);
      if (result.status !== 0) throw new Error(result.stderr);
      return result.stdout;
    });
    try { await expect(buildNativeProduction({ repo, root, env: {}, run })).rejects.toBe(afterEngine); }
    finally { statfs.mockRestore(); }
    expect(fs.readdirSync(path.join(root, "app/binaries"))).toEqual([expect.stringMatching(engineBinary)]);
    expect(buildSidecar(path.join(root, "app/scripts/build-sidecar.mjs"), "9.9.9").status).toBe(1);
  });
});
