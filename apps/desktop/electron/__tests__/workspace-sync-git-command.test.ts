import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runGit } from "../workspace-sync/git";

const roots: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

describe("cloud sync Git subprocess credentials", () => {
  it("passes the token only in one child environment and ignores inherited Git configuration", async () => {
    const root = await mkdtemp(join(tmpdir(), "sync-git-command-")); roots.push(root);
    const bin = join(root, "bin"); await mkdir(bin);
    const fixture = "synthetic-github-read-token", encoded = Buffer.from(`x-access-token:${fixture}`).toString("base64");
    await writeFile(join(bin, "git"), `#!${process.execPath}
process.stdout.write(JSON.stringify({
  args: process.argv.slice(2),
  tokenOnlyInConfigValue: process.env.GIT_CONFIG_VALUE_0 === ${JSON.stringify(`AUTHORIZATION: basic ${encoded}`)},
  key: process.env.GIT_CONFIG_KEY_0,
  global: process.env.GIT_CONFIG_GLOBAL,
  noSystem: process.env.GIT_CONFIG_NOSYSTEM,
  noLazy: process.env.GIT_NO_LAZY_FETCH,
  prompt: process.env.GIT_TERMINAL_PROMPT,
  inherited: !!(process.env.GIT_CONFIG_PARAMETERS || process.env.GIT_DIR || process.env.GIT_ASKPASS || process.env.GITHUB_TOKEN),
}));
`);
    await chmod(join(bin, "git"), 0o755);
    vi.stubEnv("PATH", `${bin}:${process.env.PATH}`);
    for (const key of ["GIT_CONFIG_PARAMETERS", "GIT_DIR", "GIT_ASKPASS", "GITHUB_TOKEN"]) vi.stubEnv(key, "synthetic-inherited-value");
    vi.stubEnv("GIT_CONFIG_GLOBAL", join(root, "foreign-config"));
    const result = JSON.parse(await runGit(["fetch", "origin"], { githubToken: { token: fixture, repository: "example/repo" } }));
    expect(result).toMatchObject({ tokenOnlyInConfigValue: true, key: "http.https://github.com/example/repo.extraHeader", global: "/dev/null", noSystem: "1", noLazy: "1", prompt: "0", inherited: false });
    expect(result.args).toEqual(expect.arrayContaining(["core.hooksPath=/dev/null", "core.fsmonitor=false", "credential.helper=", "gc.auto=0", "protocol.allow=never", "protocol.https.allow=always", "fetch.fsckObjects=true", "transfer.fsckObjects=true", "http.followRedirects=false"]));
    expect(JSON.stringify(result.args)).not.toContain(fixture);
    expect(JSON.stringify(result.args)).not.toContain(encoded);
    const next = JSON.parse(await runGit(["--version"]));
    expect(next.tokenOnlyInConfigValue).toBe(false);
    expect(next.args).not.toContain("protocol.https.allow=always");
    expect(next.args).not.toContain("protocol.file.allow=always");
    expect(JSON.parse(await runGit(["fetch", "verified.bundle"], { fileTransport: true })).args).toContain("protocol.file.allow=always");
  });

  it("refuses malformed credential scope before starting a child", async () => {
    await expect(runGit(["--version"], { githubToken: { token: "synthetic", repository: "example/repo\nextra" } })).rejects.toThrow("Invalid Git credential");
    await expect(runGit(["--version"], { githubToken: { token: "synthetic\nextra", repository: "example/repo" } })).rejects.toThrow("Invalid Git credential");
  });
});
