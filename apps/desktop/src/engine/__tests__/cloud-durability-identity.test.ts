import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  configuration: vi.fn(),
  command: vi.fn(
    async (
      _binary: string,
      _args: string[],
      _options: Record<string, unknown>,
    ) => {
      throw new Error("checkpoint-spawn-observed");
    },
  ),
}));
vi.mock("../agents/containment/cloud-worker-config", () => ({
  loadCloudWorkerConfiguration: mocks.configuration,
}));
vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  const { promisify } = await import("node:util");
  const execFile = () => {
    throw new Error("unexpected callback execution");
  };
  Object.defineProperty(execFile, promisify.custom, { value: mocks.command });
  return { ...original, execFile };
});

describe("cloud checkpoint Git identity", () => {
  let root: string;
  beforeEach(async () => {
    vi.resetModules();
    mocks.command.mockClear();
    mocks.configuration.mockReset().mockReturnValue({ uid: 10001, gid: 10001 });
    root = await mkdtemp(path.join(tmpdir(), "zeros-checkpoint-identity-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });
  it("enumerates checkout objects as the worker, without network or engine authority", async () => {
    const { scanCloudWorkspaceChanges } =
      await import("../cloud-durability-runtime");
    await expect(scanCloudWorkspaceChanges(root)).rejects.toThrow(
      "checkpoint-spawn-observed",
    );
    expect(mocks.command).toHaveBeenCalled();
    for (const [binary, , options] of mocks.command.mock.calls) {
      expect(binary).toBe("git");
      expect(options).toMatchObject({
        uid: 10001,
        gid: 10001,
        env: {
          GIT_ALLOW_PROTOCOL: "",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_TERMINAL_PROMPT: "0",
        },
      });
      expect(options.env).not.toHaveProperty("ZEROS_CLOUD_TOKEN");
    }
  });
  it("does not spawn a checkpoint Git process after invalid deployment admission", async () => {
    mocks.configuration.mockImplementation(() => {
      throw new Error("invalid deployment marker");
    });
    const { scanCloudWorkspaceChanges } =
      await import("../cloud-durability-runtime");
    await expect(scanCloudWorkspaceChanges(root)).rejects.toThrow(
      "invalid deployment marker",
    );
    expect(mocks.command).not.toHaveBeenCalled();
  });
});
