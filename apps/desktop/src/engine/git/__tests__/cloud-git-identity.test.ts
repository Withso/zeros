import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const configuration = vi.hoisted(() => vi.fn());
vi.mock("../../agents/containment/cloud-worker-config", () => ({
  loadCloudWorkerConfiguration: configuration,
}));

describe("cloud managed Git identity", () => {
  let directory: string;
  const worker = { uid: process.getuid!(), gid: process.getgid!() };
  const spawn = vi.fn(
    (_command: string[], _options: Record<string, unknown>) => ({
      stdout: new Response("").body,
      stderr: new Response("").body,
      exited: Promise.resolve(0),
      signalCode: null,
      killed: false,
    }),
  );

  beforeEach(async () => {
    vi.resetModules();
    configuration.mockReset().mockReturnValue(worker);
    spawn.mockClear();
    vi.stubGlobal("Bun", { spawn });
    directory = await mkdtemp(path.join(tmpdir(), "zeros-cloud-git-identity-"));
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    await rm(directory, { force: true, recursive: true });
  });

  it("runs both config inspection and the final operation as the checkout owner", async () => {
    const { runGit } = await import("../git-exec");
    await runGit(directory, ["status", "--porcelain=v1"]);
    expect(spawn.mock.calls.length).toBeGreaterThanOrEqual(2);
    for (const [, options] of spawn.mock.calls) {
      expect(options).toMatchObject(worker);
    }
    expect(configuration).toHaveBeenCalledOnce();
  });

  it("removes engine authority from direct Git probes as well as managed operations", async () => {
    const { runFile } = await import("../git-exec");
    vi.stubEnv("ZEROS_CLOUD_TOKEN", "fixture-engine-authority");
    await runFile("/usr/bin/git", ["config", "--list"], {
      env: {
        PATH: "/usr/bin",
        ZEROS_DATA_DIR: "/private/engine-state",
        GIT_OPTIONAL_LOCKS: "0",
      },
    });
    expect(spawn.mock.calls[0]?.[1]).toMatchObject({
      ...worker,
      env: { PATH: "/usr/bin", GIT_OPTIONAL_LOCKS: "0" },
    });
    expect(spawn.mock.calls[0]?.[1].env).not.toHaveProperty("ZEROS_DATA_DIR");
    await runFile("git", ["config", "--list"]);
    expect(spawn.mock.calls[1]?.[1].env).not.toHaveProperty(
      "ZEROS_CLOUD_TOKEN",
    );
  });

  it("rejects a different explicit identity before spawning", async () => {
    const { runGit } = await import("../git-exec");
    await expect(
      runGit(directory, ["status"], {
        identity: { uid: worker.uid + 1, gid: worker.gid },
      }),
    ).rejects.toThrow(/worker identity/i);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("does not replace local same-user execution", async () => {
    configuration.mockReturnValue(null);
    const { runFile } = await import("../git-exec");
    await runFile("git", ["status"]);
    expect(spawn.mock.calls[0]?.[1]).not.toHaveProperty("uid");
    expect(spawn.mock.calls[0]?.[1]).not.toHaveProperty("gid");
  });

  it("fails closed on an invalid deployment marker", async () => {
    configuration.mockImplementation(() => {
      throw new Error("invalid cloud marker");
    });
    const { runGit } = await import("../git-exec");
    await expect(runGit(directory, ["status"])).rejects.toThrow(
      "invalid cloud marker",
    );
    expect(spawn).not.toHaveBeenCalled();
  });
});
