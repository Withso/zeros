import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import runtimeLayout from "../cloud-workspace-validation/sandbox/runtime-layout.json";

const fixture = vi.hoisted(() => ({ document: Buffer.alloc(0), offset: 0, spawn: vi.fn() }));
vi.mock("node:child_process", async (original) => ({
  ...await original<typeof import("node:child_process")>(),
  spawnSync: fixture.spawn,
}));
vi.mock("node:fs", async (original) => ({
  ...await original<typeof import("node:fs")>(),
  readSync: (_fd: number, target: Buffer, offset: number, length: number) => {
    const size = Math.min(length, fixture.document.length - fixture.offset);
    fixture.document.copy(target, offset, fixture.offset, fixture.offset + size);
    fixture.offset += size;
    return size;
  },
}));
afterEach(() => vi.restoreAllMocks());

it("runs the unprivileged host setup in the physical repository, before the engine mount view exists", async () => {
  vi.resetModules();
  fixture.offset = 0;
  fixture.document = Buffer.from(JSON.stringify({ version: 1, command: "pwd", environment: {}, timeoutMs: 1000 }));
  fixture.spawn.mockReturnValue({ status: 0 });
  const argv = process.argv, exitCode = process.exitCode;
  vi.spyOn(process, "getuid").mockReturnValue(10001);
  vi.spyOn(process, "platform", "get").mockReturnValue("linux");
  process.argv = [process.execPath, path.resolve("scripts/cloud-workspace-validation/sandbox/cloud-setup-process.mjs"), "--unprivileged"];
  try {
    await import("../cloud-workspace-validation/sandbox/cloud-setup-process.mjs");
    expect(fixture.spawn).toHaveBeenCalledWith("/bin/bash", ["--noprofile", "--norc", "-lc", "pwd"], expect.objectContaining({
      cwd: runtimeLayout.repository,
      env: expect.objectContaining({ USER: "zeros-agent" }),
    }));
    expect(runtimeLayout.repository).not.toBe(runtimeLayout.logicalRepository);
  } finally {
    process.argv = argv;
    process.exitCode = exitCode;
  }
});
