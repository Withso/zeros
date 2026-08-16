import { accessSync, constants as fsConstants, realpathSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runFile } from "../../../git/git-exec";
import { ShadowGitRemoteBroker } from "../shadow-git-remote-broker";
import { newTerritoryGeneration } from "../status";

function executable(name: string): string {
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, name);
    try {
      accessSync(candidate, fsConstants.X_OK);
      return realpathSync(candidate);
    } catch {
      // Keep searching the test runner's PATH.
    }
  }
  throw new Error(`${name} is unavailable`);
}

describe("ZSR shadow Git remote broker", () => {
  const roots: string[] = [];
  const brokers: ShadowGitRemoteBroker[] = [];

  afterEach(async () => {
    await Promise.all(brokers.map((broker) => broker.close()));
    await Promise.all(
      roots.map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  it("aborts the active operation and refuses queued work when revoked", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "zeros-git-broker-"));
    roots.push(root);
    const toolsRoot = path.join(root, "tools");
    await mkdir(toolsRoot, { mode: 0o700 });
    let calls = 0;
    const observed: { signal: AbortSignal | null } = { signal: null };
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const broker = await ShadowGitRemoteBroker.start({
      toolsRoot,
      runtime: process.execPath,
      gitBinary: executable("git"),
      generation: newTerritoryGeneration(),
      async handleRemote(_operation, _args, _cwd, signal): Promise<never> {
        calls += 1;
        observed.signal = signal;
        markStarted();
        return new Promise<never>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        });
      },
    });
    brokers.push(broker);
    const client = path.join(toolsRoot, "git");
    const first = runFile(client, ["fetch", "origin"], {
      cwd: root,
      timeoutMs: 5_000,
      env: process.env as Record<string, string>,
    });
    await started;
    const queued = runFile(client, ["push", "origin", "main"], {
      cwd: root,
      timeoutMs: 5_000,
      env: process.env as Record<string, string>,
    });

    await expect(broker.close()).resolves.toBeUndefined();
    await expect(first).rejects.toBeDefined();
    await expect(queued).rejects.toBeDefined();
    expect(calls).toBe(1);
    expect(observed.signal?.aborted).toBe(true);
  });

  it("preserves the delegated native Git exit status", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "zeros-git-delegate-"));
    roots.push(root);
    const toolsRoot = path.join(root, "tools");
    const nativeGit = path.join(root, "native-git");
    await mkdir(toolsRoot, { mode: 0o700 });
    await writeFile(nativeGit, "#!/bin/sh\nexit 37\n", { mode: 0o700 });
    const broker = await ShadowGitRemoteBroker.start({
      toolsRoot,
      runtime: process.execPath,
      gitBinary: nativeGit,
      generation: newTerritoryGeneration(),
      async handleRemote() {
        return { stdout: "", stderr: "", delegateNative: true };
      },
    });
    brokers.push(broker);

    await expect(
      runFile(path.join(toolsRoot, "git"), ["fetch", "unconfigured"], {
        cwd: root,
        timeoutMs: 5_000,
        env: process.env as Record<string, string>,
      }),
    ).rejects.toMatchObject({ code: 37 });
  });
});
