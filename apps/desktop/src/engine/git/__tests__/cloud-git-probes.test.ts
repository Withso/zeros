import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const boundary = vi.hoisted(() => ({
  configuration: vi.fn(),
  calls: vi.fn(),
}));
vi.mock("../../agents/containment/cloud-worker-config", () => ({
  loadCloudWorkerConfiguration: boundary.configuration,
}));
vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return {
    ...original,
    execFileSync: (...args: Parameters<typeof original.execFileSync>) => {
      boundary.calls(...args);
      const options = args[2] as { uid?: number; gid?: number; env?: NodeJS.ProcessEnv };
      if (options?.uid !== process.getuid!() || options?.gid !== process.getgid!())
        throw new Error("Git probe did not select the checkout owner");
      if (!options.env || "ZEROS_CLOUD_TOKEN" in options.env)
        throw new Error("Git probe inherited engine authority");
      return original.execFileSync(...args);
    },
  };
});

describe("cloud synchronous Git probes", () => {
  let root: string;
  beforeEach(async () => {
    vi.resetModules();
    boundary.calls.mockClear();
    boundary.configuration.mockReset().mockReturnValue({
      uid: process.getuid!(), gid: process.getgid!(),
    });
    vi.stubEnv("ZEROS_CLOUD_TOKEN", "fixture-engine-authority");
    root = mkdtempSync(path.join(tmpdir(), "zeros-cloud-git-probes-"));
    const { execFileSync } = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    execFileSync("git", ["init", "--quiet", root]);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  it("checks Design visibility as the worker without engine authority", async () => {
    const { assertDesignFilesNotIgnored } = await import("../../design/gitignore");
    expect(() => assertDesignFilesNotIgnored(root, ["Design/design.toml", "Design/rules.md"])).not.toThrow();
    expect(boundary.calls).toHaveBeenCalledOnce();
  });

  it("validates personal settings exclusions as the worker without engine authority", async () => {
    const { ensureLocalSettingsIgnored } = await import("../../settings/personal-repo");
    expect(() => ensureLocalSettingsIgnored(root)).not.toThrow();
    expect(boundary.calls.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it("rejects both probe paths before spawning when the deployment marker is invalid", async () => {
    boundary.configuration.mockImplementation(() => { throw new Error("invalid deployment marker"); });
    const { assertDesignFilesNotIgnored } = await import("../../design/gitignore");
    const { ensureLocalSettingsIgnored } = await import("../../settings/personal-repo");
    expect(() => assertDesignFilesNotIgnored(root, ["Design/design.toml"])).toThrow("invalid deployment marker");
    expect(() => ensureLocalSettingsIgnored(root)).toThrow("invalid deployment marker");
    expect(boundary.calls).not.toHaveBeenCalled();
  });
});
