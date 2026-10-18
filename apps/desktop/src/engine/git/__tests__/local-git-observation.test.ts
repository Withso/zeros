import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmod, mkdtemp, mkdir, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { engineGitBinary, runFile, runGitProbeSync } from "../git-exec";
import * as credentialBroker from "../credential-broker";

let directory: string;
beforeEach(async () => { directory = await mkdtemp(path.join(tmpdir(), "zeros-engine-git-observation-")); });
afterEach(async () => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); await rm(directory, { recursive: true, force: true }); });

describe("Local engine Git observations", () => {
  it("revalidates a cached binary when an installation changes its symlink", async () => {
    const bin = path.join(directory, "bin"); await mkdir(bin);
    const first = path.join(directory, "git-first"), second = path.join(directory, "git-second");
    await writeFile(first, '#!/bin/sh\nprintf "first\\n"\n', { mode: 0o700 });
    await writeFile(second, '#!/bin/sh\nprintf "second\\n"\n', { mode: 0o700 });
    const link = path.join(bin, "git"); await symlink(first, link);
    vi.stubEnv("PATH", bin);
    expect(engineGitBinary()).toBe(first);
    await unlink(link); await symlink(second, link); await unlink(first);
    expect(engineGitBinary()).toBe(second);
    expect((await runFile("git", ["--version"])).stdout).toBe("second\n");
  });

  it.each(["created", "unexecutable", "shim"])("revalidates PATH precedence when a candidate is %s", async (change) => {
    const preferred = path.join(directory, "preferred"), fallback = path.join(directory, "fallback");
    await mkdir(preferred); await mkdir(fallback);
    const first = path.join(preferred, "git"), second = path.join(fallback, "git");
    const binary = '#!/bin/sh\nprintf "fixture\\n"\n';
    await writeFile(second, binary, { mode: 0o700 });
    if (change !== "created") await writeFile(first, binary, { mode: 0o700 });
    vi.stubEnv("PATH", `${preferred}${path.delimiter}${fallback}`);
    expect(engineGitBinary()).toBe(change === "created" ? second : first);
    if (change === "created") await writeFile(first, binary, { mode: 0o700 });
    else if (change === "unexecutable") await chmod(first, 0o600);
    else await writeFile(first, '#!/bin/sh\nreal="${ZEROS_REAL_GIT_PATH:?}"\nexec "$real" "$@"\n');
    expect(engineGitBinary()).toBe(change === "created" ? first : second);
  });

  it("retains a validated resolution without reading executable contents on every call", async () => {
    const bin = path.join(directory, "bin"); await mkdir(bin);
    const git = path.join(bin, "git");
    await writeFile(git, '#!/bin/sh\nprintf "fixture\\n"\n', { mode: 0o700 });
    vi.stubEnv("PATH", bin);
    const resolve = vi.spyOn(credentialBroker, "findLocalGitExecutable");
    try {
      for (let i = 0; i < 100; i += 1) expect(engineGitBinary()).toBe(git);
      expect(resolve).toHaveBeenCalledTimes(1);
    } finally { resolve.mockRestore(); }
  });

  it.each(["directory", "alias", "copied"])("bypasses an inherited %s shim without running its health probe", async (kind) => {
    const bin = path.join(directory, "bin");
    const shim = path.join(directory, "zeros-git-auth-fixture");
    const alias = path.join(directory, "alias");
    const log = path.join(directory, "launches");
    await mkdir(bin); await mkdir(shim);
    await writeFile(path.join(bin, "git"), '#!/bin/sh\nprintf "git\\n" >> "$ZEROS_TEST_SPAWN_LOG"\nprintf "fixture\\n"\n', { mode: 0o700 });
    const source = '#!/bin/sh\nreal="${ZEROS_REAL_GIT_PATH:?}"\nprintf "shim-health\\n" >> "$ZEROS_TEST_SPAWN_LOG"\nexec "$real" "$@"\n';
    await writeFile(path.join(shim, "git"), source, { mode: 0o700 });
    if (kind === "alias") await symlink(shim, alias);
    if (kind === "copied") { await mkdir(alias); await writeFile(path.join(alias, "git"), source, { mode: 0o700 }); }
    const env = { ...process.env, PATH: `${kind === "directory" ? shim : alias}${path.delimiter}${bin}`, ZEROS_REAL_GIT_PATH: path.join(bin, "git"), ZEROS_TEST_SPAWN_LOG: log };
    expect((await runFile("git", ["--version"], { env })).stdout).toBe("fixture\n");
    for (const [key, value] of Object.entries(env)) {
      if (key === "PATH" || key.startsWith("ZEROS_")) vi.stubEnv(key, value);
    }
    expect(runGitProbeSync(directory, "rev_parse", ["rev-parse", "--git-dir"])).toBe("fixture\n");
    expect((await readFile(log, "utf8")).split("\n").filter(Boolean)).toEqual(["git", "git"]);
  });

  const reads = [
    ["status", "--porcelain=v2", "-z"], ["diff", "--numstat"], ["log", "-1"], ["show", "HEAD:file"],
    ["ls-files", "-o", "-i", "--exclude-standard", "--directory"], ["ls-tree", "HEAD"],
    ["rev-parse", "--git-dir"], ["merge-base", "HEAD", "main"], ["diff-tree", "HEAD", "main"],
    ["cat-file", "blob", "HEAD:file"], ["config", "--null", "--list", "--includes"],
    ["-C", "/fixture", "remote", "get-url", "origin"], ["worktree", "list", "--porcelain"],
    ["symbolic-ref", "--quiet", "--short", "HEAD"], ["check-ignore", "--stdin"],
  ];
  it.each(reads.map((args) => ({ args })))("disables optional index writes for $args", async ({ args }) => {
    const spawn = vi.fn((_command: string[], _options: Record<string, unknown>) => ({ stdout: null, stderr: null, exited: Promise.resolve(0), signalCode: null, killed: false }));
    vi.stubGlobal("Bun", { spawn });
    await runFile("git", args);
    expect(spawn.mock.calls[0]?.[1]).toMatchObject({ env: { GIT_OPTIONAL_LOCKS: "0" } });
  });

  it.each([["add", "-A"], ["update-index", "--refresh"], ["config", "example.key", "value"], ["worktree", "add", "/fixture"]])(
    "preserves mutation behavior: %s %s", async (...args) => {
      const spawn = vi.fn((_command: string[], _options: Record<string, unknown>) => ({ stdout: null, stderr: null, exited: Promise.resolve(0), signalCode: null, killed: false }));
      vi.stubGlobal("Bun", { spawn });
      await runFile("git", args, { env: { PATH: process.env.PATH, GIT_OPTIONAL_LOCKS: "1" } });
      expect(spawn.mock.calls[0]?.[1]).toMatchObject({ env: { GIT_OPTIONAL_LOCKS: "1" } });
    },
  );

  it("leaves the qualified cloud executable and environment unchanged", async () => {
    const spawn = vi.fn((_command: string[], _options: Record<string, unknown>) => ({ stdout: null, stderr: null, exited: Promise.resolve(0), signalCode: null, killed: false }));
    vi.stubGlobal("Bun", { spawn });
    const env = { PATH: "/fixture/zeros-git-auth-cloud:/usr/bin", GIT_OPTIONAL_LOCKS: "1" };
    await runFile("git", ["status", "--short"], { env, identity: { uid: 10003, gid: 10003 } });
    expect(spawn.mock.calls[0]).toMatchObject([["git", "status", "--short"], { env, uid: 10003, gid: 10003 }]);
  });
});
