import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { CloudWorkspaceEnvironment } from "@zeros/protocol/cloud-v2-relay";
import { seedEnvironment } from "../environment-seed";
import { repositoryFixture } from "./repository-fixture";

const material = (): CloudWorkspaceEnvironment => ({ versionId: randomUUID(), repositoryId: "42", variables: { APP_SECRET: "synthetic-app-secret" },
  files: [{ path: ".env.local", content: "VALUE=synthetic-file-secret\n" }, { path: "private-env/.env.local", content: "VALUE=synthetic-nested-secret\n" }] });
async function fixture() {
  const f = await repositoryFixture(), environment = material();
  await writeFile(join(f.root, ".gitignore"), ".env*\nprivate-env/\n");
  const seed = (input = environment, signal = new AbortController().signal) => seedEnvironment(f.scope, f.state, input, signal);
  const journal = () => readFile(join(f.state, "environment-seed", "manifest.json"), "utf8").then(JSON.parse);
  return { ...f, environment, seed, journal };
}
describe("durable cloud environment seeds", () => {
  it("writes ignored untracked paths with private modes and journals no values", async () => {
    const f = await fixture(); await f.seed();
    for (const file of f.environment.files) {
      expect(await readFile(join(f.root, file.path), "utf8") === file.content).toBe(true);
      expect((await stat(join(f.root, file.path))).mode & 0o777).toBe(0o600);
    }
    const journal = await f.journal();
    expect(journal).toMatchObject({ complete: true, workspace: f.scope.key, versionId: f.environment.versionId });
    for (const value of [...Object.values(f.environment.variables), ...f.environment.files.map(file => file.content)])
      expect(JSON.stringify(journal).includes(value)).toBe(false);
    expect(await f.git("diff", "--cached", "--name-only")).toBe("");
  });
  it("preserves completed edits and deletions on a fresh seed service", async () => {
    const f = await fixture(); await f.seed();
    await writeFile(join(f.root, ".env.local"), "user-edited\n");
    await rm(join(f.root, "private-env/.env.local"));
    await f.seed();
    expect(await readFile(join(f.root, ".env.local"), "utf8")).toBe("user-edited\n");
    await expect(stat(join(f.root, "private-env/.env.local"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(f.seed({ ...f.environment, versionId: randomUUID() })).rejects.toMatchObject({ code: "cloud_environment_pin_changed" });
    await expect(seedEnvironment(f.scope, f.state, undefined, new AbortController().signal)).rejects.toMatchObject({ code: "cloud_environment_pin_changed" });
  });
  it.each(["tracked", "visible", "existing", "symlink", "nested-owner"])("refuses %s paths before publishing any seed", async kind => {
    const f = await fixture();
    if (kind === "tracked") { await writeFile(join(f.root, ".env.local"), "tracked"); await f.git("add", "-f", ".env.local"); await rm(join(f.root, ".env.local")); }
    if (kind === "visible") await writeFile(join(f.root, ".gitignore"), "/.env*\n");
    if (kind === "existing") await writeFile(join(f.root, ".env.local"), "existing");
    if (kind === "symlink") { await mkdir(join(f.root, "elsewhere")); await symlink(join(f.root, "elsewhere"), join(f.root, "private-env")); }
    if (kind === "nested-owner") { await mkdir(join(f.root, "private-env", ".git"), { recursive: true }); }
    const code = kind === "tracked" ? "cloud_environment_path_untracked_required" : kind === "visible" ? "cloud_environment_path_ignored_required" : "cloud_environment_path_conflict";
    await expect(f.seed()).rejects.toMatchObject({ code });
    if (kind === "existing") expect(await readFile(join(f.root, ".env.local"), "utf8")).toBe("existing");
    else await expect(stat(join(f.root, ".env.local"))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("retains an external Git lock and retries without publishing or changing the index", async () => {
    const f = await fixture(), lock = join(f.root, ".git/index.lock");
    await writeFile(lock, "another-writer");
    await expect(f.seed()).rejects.toMatchObject({ code: "EEXIST" });
    expect(await readFile(lock, "utf8")).toBe("another-writer");
    await expect(stat(join(f.root, ".env.local"))).rejects.toMatchObject({ code: "ENOENT" });
    await rm(lock); await f.seed(); expect((await f.journal()).complete).toBe(true);
  });
  it("retires a completed seed's private alias after a crash before cleanup", async () => {
    const f = await fixture(), env = { ...f.environment, files: [f.environment.files[0]!] };
    const directory = join(f.state, "environment-seed"); await mkdir(directory);
    const alias = randomUUID(), staged = join(directory, alias), target = join(f.root, ".env.local");
    await writeFile(staged, env.files[0]!.content, { mode: 0o600 });
    const info = await stat(staged); await link(staged, target);
    await writeFile(join(directory, "manifest.json"), JSON.stringify({ version: 1, workspace: f.scope.key, versionId: env.versionId, repositoryId: env.repositoryId,
      complete: false, files: [{ path: ".env.local", alias, dev: info.dev, ino: info.ino, phase: "complete" }] }));
    await f.seed(env);
    expect((await stat(target)).nlink).toBe(1);
    await expect(stat(staged)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await f.journal()).complete).toBe(true);
  });
  it.each(["preparing", "prepared", "publishing", "deleted-after-publish", "replaced-after-publish"])("recovers only provable publication after %s interruption", async phase => {
    const f = await fixture(), env = { ...f.environment, files: [f.environment.files[0]!] };
    const directory = join(f.state, "environment-seed"); await mkdir(directory);
    const alias = randomUUID(), staged = join(directory, alias);
    await writeFile(staged, phase === "preparing" ? "partial" : env.files[0]!.content, { mode: 0o600 });
    const info = await stat(staged);
    if (phase === "publishing") await link(staged, join(f.root, ".env.local"));
    if (phase === "replaced-after-publish") await writeFile(join(f.root, ".env.local"), "replacement");
    await writeFile(join(directory, "manifest.json"), JSON.stringify({ version: 1, workspace: f.scope.key, versionId: env.versionId, repositoryId: env.repositoryId,
      complete: false, files: [{ path: ".env.local", alias, dev: info.dev, ino: info.ino, phase: phase.includes("after-publish") ? "publishing" : phase }] }));
    if (phase.includes("after-publish")) {
      await expect(f.seed(env)).rejects.toMatchObject({ code: phase === "deleted-after-publish" ? "cloud_environment_seed_uncertain" : "cloud_environment_path_conflict" });
      if (phase === "deleted-after-publish") await expect(stat(join(f.root, ".env.local"))).rejects.toMatchObject({ code: "ENOENT" });
      else expect(await readFile(join(f.root, ".env.local"), "utf8")).toBe("replacement");
    } else {
      await f.seed(env); expect((await f.journal()).complete).toBe(true);
      expect(await readFile(join(f.root, ".env.local"), "utf8") === env.files[0]!.content).toBe(true);
    }
  });
});

describe("seed proof v2: content digests, not inodes", () => {
  const digest = (content: string) => createHash("sha256").update(content).digest("hex");
  it("records the exact bytes' SHA-256 for each seeded target, and no value", async () => {
    const f = await fixture(); await f.seed();
    const journal = await f.journal();
    expect(journal.version).toBe(2);
    expect(journal.files.map((file: { path: string; sha256: string }) => [file.path, file.sha256])).toEqual(f.environment.files.map(file => [file.path, digest(file.content)]));
  });
  it("upgrades a complete version-1 journal from the configured content, leaving the files on disk as they are", async () => {
    const f = await fixture(); await f.seed();
    const path = join(f.state, "environment-seed", "manifest.json"), journal = await f.journal();
    await writeFile(path, JSON.stringify({ ...journal, version: 1, files: journal.files.map(({ sha256: _digest, ...file }: Record<string, unknown>) => file) }));
    await writeFile(join(f.root, ".env.local"), "VALUE=edited-by-a-person\n");
    await f.seed();
    const upgraded = await f.journal();
    expect(upgraded.version).toBe(2);
    expect(upgraded.files[0].sha256).toBe(digest(f.environment.files[0]!.content));
    expect(await readFile(join(f.root, ".env.local"), "utf8")).toBe("VALUE=edited-by-a-person\n");
  });
});
