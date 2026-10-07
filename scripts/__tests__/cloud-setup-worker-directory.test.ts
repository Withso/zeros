import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import runtimeLayout from "../cloud-workspace-validation/sandbox/runtime-layout.json";

const fixture = vi.hoisted(() => ({ document: Buffer.alloc(0), offset: 0, spawn: vi.fn(), admittedPath: "" }));
vi.mock("../cloud-workspace-validation/sandbox/cloud-computer-checkout.mjs", async (original) => ({
  ...await original<typeof import("../cloud-workspace-validation/sandbox/cloud-computer-checkout.mjs")>(),
  cloudComputerHostRepository: () => fixture.admittedPath,
}));
vi.mock("../cloud-workspace-validation/sandbox/cloud-runtime-root.mjs", async (original) => {
  const module = await original<typeof import("../cloud-workspace-validation/sandbox/cloud-runtime-root.mjs")>();
  const runtime = (await import("../../apps/desktop/src/engine/agents/__tests__/helpers/test-cloud-runtime")).testCloudRuntime();
  const templateRuntime = () => ({ ...runtime, node: process.execPath,
    helpers: { ...runtime.helpers, setupProcess: path.resolve("scripts/cloud-workspace-validation/sandbox/cloud-setup-process.mjs") } });
  return { ...module,
    resolveCloudRuntime: templateRuntime,
    resolveCloudRuntimeChild: templateRuntime };
});
vi.mock("node:child_process", async (original) => ({
  ...await original<typeof import("node:child_process")>(),
  spawnSync: fixture.spawn,
}));
vi.mock("node:fs", async (original) => ({
  ...await original<typeof import("node:fs")>(),
  readSync: (fd: number, target: Buffer, offset: number, length: number) => {
    if (fd === 3) { target[offset] = 42; return 1; }
    const size = Math.min(length, fixture.document.length - fixture.offset);
    fixture.document.copy(target, offset, fixture.offset, fixture.offset + size);
    fixture.offset += size;
    return size;
  },
}));
afterEach(() => vi.restoreAllMocks());

it.each([false, true])("runs v4 host setup in the physical repository before the engine view exists (privileged: %s)", async privileged => {
  vi.resetModules();
  fixture.spawn.mockClear();
  fixture.offset = 0;
  fixture.document = Buffer.from(JSON.stringify({ version: 1, command: "pwd", environment: {}, timeoutMs: 1000 }));
  fixture.spawn.mockReturnValue({ status: 0 });
  const argv = process.argv, exitCode = process.exitCode;
  vi.spyOn(process, "execPath", "get").mockReturnValue(`/opt/zeros-infra/r1-${"a".repeat(64)}/bin/node`);
  vi.spyOn(process, "getuid").mockReturnValue(privileged ? 0 : 10001);
  vi.spyOn(process, "platform", "get").mockReturnValue("linux");
  const physical = "/srv/zeros/files/repos/fixture/primary";
  fixture.admittedPath = physical;
  const helperPath = path.resolve("scripts/cloud-workspace-validation/sandbox/cloud-setup-process.mjs");
  vi.spyOn(process, "cwd").mockReturnValue(physical);
  process.argv = [process.execPath, helperPath, privileged ? "--worker" : "--unprivileged"];
  try {
    await import("../cloud-workspace-validation/sandbox/cloud-setup-process.mjs");
    expect(fixture.spawn).toHaveBeenCalledWith(privileged ? "/usr/bin/setpriv" : "/bin/bash",
      privileged ? expect.arrayContaining(["--reuid=10001", "--unprivileged"]) : ["--noprofile", "--norc", "-lc", "pwd"], expect.objectContaining({
      cwd: physical,
      env: expect.objectContaining({ USER: "zeros-agent" }),
    }));
    expect(runtimeLayout.repository).not.toBe(runtimeLayout.logicalRepository);
  } finally {
    process.argv = argv;
    process.exitCode = exitCode;
  }
});
