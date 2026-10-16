import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, symlink, rm, realpath, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fingerprintFiles, linkDependencies, resolveFix } from "../zstack/source.mjs";

const roots: string[] = [];
async function root() { const dir = await mkdtemp(path.join(os.tmpdir(), "zstack-source-")); roots.push(dir); return dir; }
afterEach(async () => { for (const dir of roots.splice(0)) await rm(dir, { recursive: true, force: true }); });

describe("zstack source identity and projection", () => {
  it("hashes bytes, executable mode and deletions, without reading excluded credentials", async () => {
    const dir = await root(); await mkdir(path.join(dir, "scripts"));
    await writeFile(path.join(dir, "scripts/a.mjs"), "one");
    const before = await fingerprintFiles(dir, ["scripts/a.mjs"]);
    await writeFile(path.join(dir, "scripts/a.mjs"), "two");
    expect(await fingerprintFiles(dir, ["scripts/a.mjs"])).not.toBe(before);
    await expect(fingerprintFiles(dir, [".env.agent"])).rejects.toThrow("zstack_path_invalid");
    await rm(path.join(dir, "scripts/a.mjs"));
    expect(await fingerprintFiles(dir, ["scripts/a.mjs"])).not.toBe(before);
  });

  it("refuses source aliases instead of hashing a file outside the projection", async () => {
    const dir = await root(), elsewhere = await root();
    await writeFile(path.join(elsewhere, "source.mjs"), "outside");
    await symlink(elsewhere, path.join(dir, "scripts"));
    await expect(fingerprintFiles(dir, ["scripts/source.mjs"])).rejects.toThrow("zstack_source_unsafe");
  });

  it("binds workspace dependencies to projected packages, while reusing only external installs", async () => {
    const original = await root(), projection = await root();
    for (const base of [original, projection]) {
      await mkdir(path.join(base, "packages/protocol"), { recursive: true });
      await writeFile(path.join(base, "packages/protocol/package.json"), '{"name":"@zeros/protocol"}');
      await writeFile(path.join(base, "pnpm-lock.yaml"), "same lock");
    }
    await mkdir(path.join(original, "node_modules/@zeros"), { recursive: true });
    await mkdir(path.join(original, "node_modules/.pnpm/zod"), { recursive: true });
    await symlink("../../packages/protocol", path.join(original, "node_modules/@zeros/protocol"));
    await symlink(".pnpm/zod", path.join(original, "node_modules/zod"));
    await linkDependencies(original, projection, ["packages/protocol/package.json"]);
    expect(await realpath(path.join(projection, "node_modules/@zeros/protocol"))).toBe(path.join(projection, "packages/protocol"));
    expect(await realpath(path.join(projection, "node_modules/zod"))).toBe(path.join(original, "node_modules/.pnpm/zod"));
    expect(await readFile(path.join(projection, "packages/protocol/package.json"), "utf8")).toContain("@zeros/protocol");
  });

  it("refuses a historical dependency graph that is not installed", async () => {
    const original = await root(), projection = await root();
    await writeFile(path.join(original, "pnpm-lock.yaml"), "installed");
    await writeFile(path.join(projection, "pnpm-lock.yaml"), "different");
    await expect(linkDependencies(original, projection, [])).rejects.toThrow("zstack_dependencies_unavailable");
  });

  it("resolves a PR only to one local immutable mainline commit and rejects ambiguity", () => {
    const sha = "a".repeat(40), parent = "b".repeat(40);
    const git = (args: string[]) => args[0] === "log" ? `${sha}\tfix (#123)\n` : `${sha} ${parent}\n`;
    expect(resolveFix("/synthetic", "pr:123", git)).toEqual({ fixed: sha, parent });
    expect(() => resolveFix("/synthetic", "pr:123", args => args[0] === "log" ? `${sha}\tfix (#123)\n${parent}\tsecond (#123)\n` : ""))
      .toThrow("zstack_revision_ambiguous");
    expect(() => resolveFix("/synthetic", "pending", git)).toThrow("zstack_revision_unavailable");
  });
});
