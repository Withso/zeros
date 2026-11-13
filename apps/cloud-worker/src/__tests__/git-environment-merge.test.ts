import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { githubEnvironment } from "../credentials/github";
import { mergeGitEnvironment, workerChildEnvironment } from "../drivers/shared/agent-environment";
import { ContextCommitIdentities } from "../sharing/identity";

const CONTEXT = "66666666-6666-4666-8666-666666666666";
const sam = { name: "Sam Member", email: "2+sam@users.noreply.github.com" };
const cleanups: string[] = [];
afterEach(async () => { for (const path of cleanups.splice(0)) await rm(path, { recursive: true, force: true }); });

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "zeros-git-env-"));
  cleanups.push(home);
  const bin = join(home, "bin"); await mkdir(bin);
  const askpass = join(bin, "git-askpass");
  await writeFile(askpass, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  await writeFile(join(bin, "git-credential"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const broker = githubEnvironment(join(home, "broker.sock"), askpass);
  const identities = new ContextCommitIdentities(home, { configEnv: true });
  identities.configure("actor", null);
  return { home, broker, identity: identities.environment(CONTEXT, sam) };
}

const pairs = (env: NodeJS.ProcessEnv) => Array.from({ length: Number(env.GIT_CONFIG_COUNT ?? 0) }, (_, i) => [env[`GIT_CONFIG_KEY_${i}`], env[`GIT_CONFIG_VALUE_${i}`]]);

describe("the broker's Git config entries survive a context's identity include", () => {
  it("puts the include first, then the broker's helper reset and erase helper, so the reset always wins", async () => {
    const f = await fixture();
    const merged = mergeGitEnvironment(f.broker, f.identity);
    expect(pairs(merged)).toEqual([
      ["include.path", f.identity.GIT_CONFIG_VALUE_0],
      ["credential.helper", ""],
      ["credential.https://github.com.helper", f.broker.GIT_CONFIG_VALUE_1],
    ]);
    expect(merged.GIT_CONFIG_COUNT).toBe("3");
    // An environment without entries changes nothing; a malformed count adds nothing.
    expect(mergeGitEnvironment(f.broker, {})).toEqual(f.broker);
    expect(pairs(mergeGitEnvironment(f.broker, { GIT_CONFIG_COUNT: "x", GIT_CONFIG_KEY_0: "a", GIT_CONFIG_VALUE_0: "b" }))).toHaveLength(2);
    expect(mergeGitEnvironment({ GIT_AUTHOR_NAME: "A" }, { GIT_AUTHOR_NAME: "B" })).toEqual({ GIT_AUTHOR_NAME: "B" });
  });

  it("joined: the producer → workerChildEnvironment keeps the include, then the reset and the erase helper", async () => {
    const f = await fixture();
    const env = workerChildEnvironment({ PATH: process.env.PATH, HOME: f.home }, mergeGitEnvironment(f.broker, f.identity));
    expect(pairs(env)).toEqual([["include.path", f.identity.GIT_CONFIG_VALUE_0], ["credential.helper", ""],
      ["credential.https://github.com.helper", f.broker.GIT_CONFIG_VALUE_1]]);
    expect(env.GIT_CONFIG_COUNT).toBe("3");
  });

  it("real Git: a stored credential helper is never consulted, and the context identity still applies", async () => {
    const f = await fixture();
    execFileSync("git", ["config", "--global", "credential.helper", "store"], { env: { PATH: process.env.PATH!, HOME: f.home } });
    await writeFile(join(f.home, ".git-credentials"), "https://stored-user:STORED-SECRET@example.test\n", { mode: 0o600 });
    const fill = (env: NodeJS.ProcessEnv) => spawnSync("git", ["credential", "fill"], { input: "protocol=https\nhost=example.test\n\n", encoding: "utf8",
      env: { ...env, PATH: process.env.PATH!, HOME: f.home, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1" } }).stdout;
    // Control: the previous overwrite (identity replaces the broker's entries) lets the store helper answer.
    expect(fill(workerChildEnvironment({}, { ...f.broker, ...f.identity }))).toContain("STORED-SECRET");
    expect(fill(workerChildEnvironment({}, mergeGitEnvironment(f.broker, f.identity)))).not.toContain("STORED-SECRET");
    const merged = workerChildEnvironment({}, mergeGitEnvironment(f.broker, f.identity));
    const name = execFileSync("git", ["config", "user.name"], { env: { ...merged, PATH: process.env.PATH!, HOME: f.home, GIT_CONFIG_NOSYSTEM: "1" }, encoding: "utf8" }).trim();
    expect(name).toBe("Sam Member");
    expect(await readFile(f.identity.GIT_CONFIG_VALUE_0!, "utf8")).toContain("Sam Member");
  });

  it("real Git: a credential helper written into the context's include file is reset and never consulted", async () => {
    const f = await fixture();
    await writeFile(join(f.home, ".git-credentials"), "https://stored-user:STORED-SECRET@example.test\n", { mode: 0o600 });
    // Anyone on the VM can edit the include; the broker's reset comes after it.
    await writeFile(f.identity.GIT_CONFIG_VALUE_0!, `[user]\n\tname = "Sam Member"\n\temail = "2+sam@users.noreply.github.com"\n[credential]\n\thelper = store\n`);
    const fill = (env: NodeJS.ProcessEnv) => spawnSync("git", ["credential", "fill"], { input: "protocol=https\nhost=example.test\n\n", encoding: "utf8",
      env: { ...env, PATH: process.env.PATH!, HOME: f.home, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1" } }).stdout;
    // Control: with the include last, its helper would answer.
    const last = { ...f.broker, GIT_CONFIG_COUNT: "3", GIT_CONFIG_KEY_2: "include.path", GIT_CONFIG_VALUE_2: f.identity.GIT_CONFIG_VALUE_0 };
    expect(fill(workerChildEnvironment({}, last))).toContain("STORED-SECRET");
    expect(fill(workerChildEnvironment({}, mergeGitEnvironment(f.broker, f.identity)))).not.toContain("STORED-SECRET");
  });
});
