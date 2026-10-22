import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { inspectRuntimeArchive } from "./runtime-artifact.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function artifact(overrides = {}, corrupt = false) {
  const root = await mkdtemp(join(tmpdir(), "cloud-runtime-artifact-")); roots.push(root);
  const dist = join(root, "dist"); await mkdir(dist);
  const files: Record<string, { sha256: string; bytes: number; mode: number }> = {};
  for (const file of ["worker.mjs", "cursor-host.mjs", "git-askpass.mjs", "gh.mjs", "bin/gh", "bin/git-askpass"]) {
    const content = Buffer.from(`fixture ${file}`);
    await mkdir(dirname(join(dist, file)), { recursive: true });
    await writeFile(join(dist, file), content);
    files[file] = { sha256: createHash("sha256").update(content).digest("hex"), bytes: content.length, mode: 0o755 };
  }
  const native = ["@openai/codex-linux-x64", "@anthropic-ai/claude-agent-sdk-linux-x64", "@cursor/sdk-linux-x64"];
  await writeFile(join(dist, "runtime-manifest.json"), JSON.stringify({ version: 1, node: "24", platform: "linux", arch: "x64",
    packages: Object.fromEntries(native.map(name => [`node_modules/${name}`, { name, version: "1.0.0" }])), files, ...overrides }));
  await writeFile(join(dist, "BUILD.json"), JSON.stringify({ commit: "a".repeat(40) }));
  if (corrupt) await writeFile(join(dist, "worker.mjs"), "different bundle");
  const archive = join(root, "runtime.tar.gz");
  execFileSync("tar", ["-czf", archive, "-C", dist, "."]);
  return archive;
}

it("accepts a packaged Linux x64 Node 24 runtime without building or installing anything", async () => {
  const result = await inspectRuntimeArchive(await artifact());
  expect(result).toMatchObject({ sha256: expect.stringMatching(/^[a-f0-9]{64}$/), bytes: expect.any(Number), commit: "a".repeat(40) });
});

it("accepts bundled subpackages whose manifest omits a package version", async () => {
  const packages = Object.fromEntries(["@openai/codex-linux-x64", "@anthropic-ai/claude-agent-sdk-linux-x64", "@cursor/sdk-linux-x64"]
    .map(name => [`node_modules/${name}`, { name, version: "1.0.0" }]));
  const archive = await artifact({ packages: { ...packages, "node_modules/@modelcontextprotocol/sdk": { name: "@modelcontextprotocol/sdk" } } });
  await expect(inspectRuntimeArchive(archive)).resolves.toHaveProperty("sha256");
});

it.each([{ platform: "darwin" }, { arch: "arm64" }, { node: "22" }, { packages: {} }])("refuses an artifact for another runtime or missing native dependencies: %j", async manifest => {
  await expect(inspectRuntimeArchive(await artifact(manifest))).rejects.toThrow(/Linux x64 Node 24/);
});

it("checks the bundled entrypoints against their manifest before publication", async () => {
  await expect(inspectRuntimeArchive(await artifact({}, true))).rejects.toThrow(/manifest/);
});

it("refuses a linked archive rather than following a mutable host path", async () => {
  const original = await artifact(), linked = `${original}.link`;
  await symlink(original, linked);
  await expect(inspectRuntimeArchive(linked)).rejects.toThrow(/regular file/);
});
