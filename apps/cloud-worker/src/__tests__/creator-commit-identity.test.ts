import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CloudV2ControlFrameSchema, CloudV2TerminalLeaseSchema, CREATOR_COMMIT_IDENTITY_FEATURE } from "@zeros/protocol/cloud-v2-relay";
import { configureGitIdentity, GIT_IDENTITY_FILE } from "../credentials/git-identity";
import { ContextCommitIdentities, reviewRequesterName } from "../sharing/identity";
import { removeLegacyMaterial } from "../sharing/legacy-material";
import { CLOUD_WORKER_FEATURES } from "../worker-features";
import { config } from "./worker-fixtures";

const creator = { name: "Alex Creator", email: "1+alex@users.noreply.github.com" };
const sam = { name: "Sam Member", email: "2+sam@users.noreply.github.com" };
const CONTEXT = "66666666-6666-4666-8666-666666666666";
const cleanups: string[] = [];
afterEach(async () => { for (const path of cleanups.splice(0)) await rm(path, { recursive: true, force: true }); });

async function home() {
  const directory = await mkdtemp(join(tmpdir(), "zeros-commit-identity-"));
  cleanups.push(directory);
  const repo = join(directory, "repo");
  await mkdir(repo);
  const git = (env: Record<string, string>, ...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8",
    env: { PATH: process.env.PATH!, HOME: directory, GIT_CONFIG_NOSYSTEM: "1", ...env } }).trim();
  git({}, "init", "-q");
  const commit = (env: Record<string, string>) => { git(env, "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "x"); return git({}, "log", "-1", "--format=%an <%ae> | %cn"); };
  return { directory, git, commit };
}

describe("Creator commit identity (creator-commit-identity-v1)", () => {
  it("parses gitIdentitySource and lease personName, and advertises the feature", () => {
    expect(CREATOR_COMMIT_IDENTITY_FEATURE).toBe("creator-commit-identity-v1");
    expect(CLOUD_WORKER_FEATURES.split(",")).toContain(CREATOR_COMMIT_IDENTITY_FEATURE);
    for (const source of ["creator", "actor"]) expect(CloudV2ControlFrameSchema.safeParse({ ...config, gitIdentitySource: source }).success).toBe(true);
    expect(CloudV2ControlFrameSchema.safeParse({ ...config, gitIdentitySource: "someone" }).success).toBe(false);
    const lease = { contextId: CONTEXT, userId: "33333333-3333-4333-8333-333333333333", expiresAt: Date.now() + 1000, gitIdentity: null };
    expect(CloudV2TerminalLeaseSchema.safeParse({ ...lease, personName: "Sam Member" }).success).toBe(true);
    expect(CloudV2TerminalLeaseSchema.safeParse(lease).success).toBe(true);
  });

  it("an open context follows the current Creator: actor while there is none, the Creator once assigned, again on Reassign", async () => {
    const h = await home();
    const identities = new ContextCommitIdentities(h.directory);
    await configureGitIdentity(h.directory, null);
    identities.configure("actor", null);
    const env = identities.environment(CONTEXT, sam);
    expect(Object.keys(env).sort()).toEqual(["GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0"]);
    expect(h.commit(env)).toBe("Sam Member <2+sam@users.noreply.github.com> | Sam Member");
    // A Creator is assigned while that terminal stays open: the same environment now commits as the Creator.
    await configureGitIdentity(h.directory, creator, { managed: true });
    identities.configure("creator", creator);
    expect(h.commit(env)).toBe("Alex Creator <1+alex@users.noreply.github.com> | Alex Creator");
    const next = { name: "Riley Next", email: "3+riley@users.noreply.github.com" };
    await configureGitIdentity(h.directory, next, { managed: true });
    identities.configure("creator", next);
    expect(h.commit(env)).toBe("Riley Next <3+riley@users.noreply.github.com> | Riley Next");
    identities.forget(CONTEXT);
    expect(existsSync(env.GIT_CONFIG_VALUE_0!)).toBe(false);
  });

  it("a Creator without a stored identity refuses the commit instead of using the actor's", async () => {
    const h = await home();
    const identities = new ContextCommitIdentities(h.directory);
    await configureGitIdentity(h.directory, null);
    identities.configure("creator", null);
    expect(() => h.commit(identities.environment(CONTEXT, sam))).toThrow();
  });

  it("an older control plane (no source) keeps today's per-person author env; old git pins the identity at open", () => {
    const legacy = new ContextCommitIdentities("/unused");
    expect(legacy.environment(CONTEXT, sam)).toEqual({ GIT_AUTHOR_NAME: sam.name, GIT_AUTHOR_EMAIL: sam.email, GIT_COMMITTER_NAME: sam.name, GIT_COMMITTER_EMAIL: sam.email });
    const old = new ContextCommitIdentities("/unused", { configEnv: false });
    old.configure("creator", creator);
    expect(old.environment(CONTEXT, sam)).toMatchObject({ GIT_AUTHOR_NAME: creator.name, GIT_COMMITTER_EMAIL: creator.email });
    old.configure("actor", null);
    expect(old.environment(CONTEXT, sam)).toMatchObject({ GIT_AUTHOR_NAME: sam.name });
  });

  it("names review comments by the lease's person, never by the commit identity", () => {
    expect(reviewRequesterName({ personName: "Sam Member", gitIdentity: creator }, "creator")).toBe("Sam Member");
    expect(reviewRequesterName({ gitIdentity: creator }, "creator")).toBeUndefined();
    expect(reviewRequesterName({ gitIdentity: sam }, undefined)).toBe("Sam Member");
  });

  it("a clean boot keeps the managed Creator identity but still removes an unmarked legacy one", async () => {
    const h = await home();
    const root = join(h.directory, "checkout"), state = join(h.directory, "state");
    await mkdir(root); await mkdir(state);
    await configureGitIdentity(h.directory, creator, { managed: true });
    expect((await removeLegacyMaterial({ root, state, home: h.directory, shm: join(h.directory, "shm") })).toString()).toBe("none");
    await writeFile(join(h.directory, GIT_IDENTITY_FILE), `[user]\n\tname = "Old"\n\temail = "old@example.test"\n`);
    expect((await removeLegacyMaterial({ root, state, home: h.directory, shm: join(h.directory, "shm") })).toString()).toBe("removed");
  });
});
