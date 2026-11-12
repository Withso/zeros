import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import type { CloudWorkspaceEnvironment } from "@zeros/protocol/cloud-v2-relay";
import { seedEnvironment } from "../../workspace/environment-seed";
import { configureGitIdentity } from "../../credentials/git-identity";
import { repositoryFixture } from "../../workspace/__tests__/repository-fixture";
import { removeLegacyMaterial } from "../legacy-material";

/** Slice D (wire Q-D2): the first activated boot removes what the phase-1 worker wrote for its Creator, only with proof. */
const environment = (): CloudWorkspaceEnvironment => ({ versionId: randomUUID(), repositoryId: "42", variables: {},
  files: [{ path: ".env.local", content: "VALUE=synthetic-creator-secret\n" }, { path: "private-env/.env.local", content: "VALUE=synthetic-nested\n" }] });
async function fixture() {
  const f = await repositoryFixture(), home = join(f.directory, "home");
  await mkdir(home);
  await writeFile(join(f.root, ".gitignore"), ".env*\nprivate-env/\n");
  const shm = join(f.directory, "shm"); await mkdir(shm);
  const remove = () => removeLegacyMaterial({ root: f.root, state: f.state, home, shm });
  const exists = (path: string) => lstat(path).then(() => true, () => false);
  return { ...f, home, shm, remove, exists };
}

it("reports none on a workspace the phase-1 worker never seeded", async () => {
  const f = await fixture();
  expect(await f.remove()).toBe("none");
});

it("removes the Creator's seeded env files, the seed journal, the Creator's Git identity and terminal screen records", async () => {
  const f = await fixture();
  await seedEnvironment(f.scope, f.state, environment(), new AbortController().signal);
  await configureGitIdentity(f.home, { name: "Creator Person", email: "1+creator@users.noreply.github.com" });
  await mkdir(join(f.state, "terminals")); await writeFile(join(f.state, "terminals", "a.json"), "{\"screen\":\"secret on screen\"}");
  await writeFile(join(f.root, "keep.txt"), "the team's file\n");
  expect(await f.remove()).toBe("removed");
  expect(await f.exists(join(f.root, ".env.local"))).toBe(false);
  expect(await f.exists(join(f.root, "private-env/.env.local"))).toBe(false);
  expect(await f.exists(join(f.state, "environment-seed"))).toBe(false);
  expect(await f.exists(join(f.root, "keep.txt"))).toBe(true);
  const identity = await readFile(join(f.home, ".config", "zeros", "git-identity"), "utf8");
  expect(identity).not.toContain("Creator");
  expect(identity).toContain("useConfigOnly = true");
  expect(await readdir(join(f.state, "terminals")).catch(() => [])).toEqual([]);
  expect(await f.remove()).toBe("none");
});

it.each([
  ["replaced by another file", async (path: string) => { await unlink(path); await writeFile(path, "VALUE=someone-else\n"); }],
  ["replaced by a symlink", async (path: string) => { await unlink(path); await symlink("/etc/hostname", path); }],
])("refuses and keeps the bytes when a seeded file was %s", async (_name, change) => {
  const f = await fixture();
  await seedEnvironment(f.scope, f.state, environment(), new AbortController().signal);
  await change(join(f.root, ".env.local"));
  expect(await f.remove()).toBe("refused");
  expect(await f.exists(join(f.root, ".env.local"))).toBe(true);
  expect(await f.exists(join(f.state, "environment-seed", "manifest.json"))).toBe(true);
});

it("treats an already deleted seeded file as gone, and an unreadable or unfinished journal as refused", async () => {
  const f = await fixture();
  await seedEnvironment(f.scope, f.state, environment(), new AbortController().signal);
  await rm(join(f.root, ".env.local"));
  expect(await f.remove()).toBe("removed");
  expect(await f.exists(join(f.root, "private-env/.env.local"))).toBe(false);
  const g = await fixture();
  await mkdir(join(g.state, "environment-seed"), { mode: 0o700 });
  await writeFile(join(g.state, "environment-seed", "manifest.json"), "not json");
  expect(await g.remove()).toBe("refused");
  const h = await fixture();
  await seedEnvironment(h.scope, h.state, environment(), new AbortController().signal);
  const path = join(h.state, "environment-seed", "manifest.json"), journal = JSON.parse(await readFile(path, "utf8"));
  journal.files[0].phase = "publishing"; journal.complete = false;
  await writeFile(path, JSON.stringify(journal));
  expect(await h.remove()).toBe("refused");
  expect(await h.exists(join(h.root, ".env.local"))).toBe(true);
});

it("refuses when a seeded file's directory was swapped for a link elsewhere, and touches nothing behind it", async () => {
  const f = await fixture();
  await seedEnvironment(f.scope, f.state, environment(), new AbortController().signal);
  const elsewhere = join(f.directory, "elsewhere");
  await mkdir(elsewhere); await writeFile(join(elsewhere, ".env.local"), "VALUE=not-ours\n");
  await rm(join(f.root, "private-env"), { recursive: true }); await symlink(elsewhere, join(f.root, "private-env"));
  expect(await f.remove()).toBe("refused");
  expect(await readFile(join(elsewhere, ".env.local"), "utf8")).toBe("VALUE=not-ours\n");
  expect(await f.exists(join(f.root, ".env.local"))).toBe(true);
});

it("refuses, and leaves the foreign file alone, when the Git identity's directory is a link elsewhere (J-D1)", async () => {
  const f = await fixture();
  const foreign = join(f.directory, "foreign-config");
  await mkdir(foreign); await writeFile(join(foreign, "git-identity"), "[user]\n\tname = \"Someone Else\"\n");
  await mkdir(join(f.home, ".config")); await symlink(foreign, join(f.home, ".config", "zeros"));
  expect(await f.remove()).toBe("refused");
  expect(await readFile(join(foreign, "git-identity"), "utf8")).toContain("Someone Else");
});

it("refuses when the Git identity is itself a link, and keeps its target", async () => {
  const f = await fixture();
  const target = join(f.directory, "elsewhere-identity");
  await writeFile(target, "[user]\n\tname = \"Creator Person\"\n");
  await mkdir(join(f.home, ".config", "zeros"), { recursive: true }); await symlink(target, join(f.home, ".config", "zeros", "git-identity"));
  expect(await f.remove()).toBe("refused");
  expect(await readFile(target, "utf8")).toContain("Creator Person");
});

it("refuses, and removes nothing, when the terminal records directory is a link elsewhere (J-D2)", async () => {
  const f = await fixture();
  const foreign = join(f.directory, "foreign-terminals");
  await mkdir(foreign); await writeFile(join(foreign, "keep.json"), "{}");
  await symlink(foreign, join(f.state, "terminals"));
  expect(await f.remove()).toBe("refused");
  expect(await readFile(join(foreign, "keep.json"), "utf8")).toBe("{}");
});

it("removes a leftover restore token directory, and refuses an unexpected one (Q-D3)", async () => {
  const f = await fixture();
  const owned = join(f.shm, "zeros-restore-auth-AbCdEf0123");
  await mkdir(owned, { mode: 0o700 }); await writeFile(join(owned, "token"), "synthetic-restore-token", { mode: 0o600 });
  await writeFile(join(f.shm, "unrelated"), "keep");
  expect(await f.remove()).toBe("removed");
  expect(await f.exists(owned)).toBe(false);
  expect(await f.exists(join(f.shm, "unrelated"))).toBe(true);
  const odd = join(f.shm, "zeros-restore-auth-ZyXw987654");
  await mkdir(odd, { mode: 0o700 }); await writeFile(join(odd, "token"), "t"); await writeFile(join(odd, "extra"), "x");
  expect(await f.remove()).toBe("refused");
  expect(await f.exists(join(odd, "extra"))).toBe(true);
  await rm(odd, { recursive: true });
  const elsewhere = join(f.directory, "elsewhere-shm"); await mkdir(elsewhere); await writeFile(join(elsewhere, "token"), "keep");
  await symlink(elsewhere, join(f.shm, "zeros-restore-auth-Link000000"));
  expect(await f.remove()).toBe("refused");
  expect(await readFile(join(elsewhere, "token"), "utf8")).toBe("keep");
});

it("refuses, and keeps the foreign record, when an ancestor of the worker's state path is a link (J-D4)", async () => {
  const f = await fixture();
  const foreign = join(f.directory, "foreign-local");
  await mkdir(join(foreign, "share", "zeros", "cloud-worker", "terminals"), { recursive: true });
  await writeFile(join(foreign, "share", "zeros", "cloud-worker", "terminals", "fixture.json"), "{}");
  await symlink(foreign, join(f.home, ".local"));
  const state = join(f.home, ".local", "share", "zeros", "cloud-worker");
  expect(await removeLegacyMaterial({ root: f.root, state, home: f.home, shm: f.shm })).toBe("refused");
  expect(await readFile(join(foreign, "share", "zeros", "cloud-worker", "terminals", "fixture.json"), "utf8")).toBe("{}");
});

it("refuses when ~/.config itself is a link, and when the checkout's parent is a link, touching nothing behind them", async () => {
  const f = await fixture();
  const foreign = join(f.directory, "foreign-config");
  await mkdir(join(foreign, "zeros"), { recursive: true }); await writeFile(join(foreign, "zeros", "git-identity"), "[user]\n\tname = \"Other\"\n");
  await symlink(foreign, join(f.home, ".config"));
  expect(await f.remove()).toBe("refused");
  expect(await readFile(join(foreign, "zeros", "git-identity"), "utf8")).toContain("Other");
  const g = await fixture();
  await seedEnvironment(g.scope, g.state, environment(), new AbortController().signal);
  const linkedParent = join(g.directory, "linked-checkouts");
  await symlink(g.directory, linkedParent);
  expect(await removeLegacyMaterial({ root: join(linkedParent, "checkout"), state: g.state, home: g.home, shm: g.shm })).toBe("refused");
  expect(await g.exists(join(g.root, ".env.local"))).toBe(true);
});
