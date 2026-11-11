import { describe, expect, it, vi } from "vitest";
import { runtimeReleaseIdentity } from "../../apps/control-plane/src/cloud/runtime-release";
import { runtimeBuildDrainVersion } from "../../apps/control-plane/src/cloud/runtime-build-drain";
import { resolveRuntimeRelease, waitForRuntimeCI } from "./runtime-auto";
import type { Channel } from "./contracts";

const source = "1".repeat(40), previousSource = "2".repeat(40), digest = "a".repeat(64), previousDigest = "b".repeat(64);
function fixture(channel: Channel = "alpha") {
  const release = { version: 1 as const, sha256: digest, sourceSha: previousSource, sourceSha256: "c".repeat(64),
    qualification: { channel: "alpha" as const, runId: "123", runAttempt: 2, completedAt: new Date().toISOString(), receiptSha256: "d".repeat(64), deleted: true as const } };
  const identity = (target: Channel, qualified = true) => ({ version: 1, channel: target, sourceSha: source, ready: true, maintenance: false,
    migrations: { state: "current", head: "migration", expectedHead: "migration", manifestSha256: "e".repeat(64) },
    cloud: { enabled: true, ready: true, state: "healthy" }, runtimeBuildDrainVersion,
    ...runtimeReleaseIdentity({ sha256: qualified ? digest : previousDigest, ...(qualified ? { release } : {}) }) });
  const current = identity(channel, channel === "alpha"), alpha = identity("alpha");
  const deps = { identity: vi.fn(async (target: Channel): Promise<unknown> => target === channel ? current : alpha),
    ancestor: vi.fn(async () => true), changes: vi.fn(async (): Promise<string[]> => []), published: vi.fn(async () => true) };
  const input = { channel, sourceSha: source, cloudEnabled: true };
  return { current, alpha, deps, input, identity, release };
}

describe("automatic runtime resolution", () => {
  it("leaves Local-only channels independent of cloud availability", async () => {
    const f = fixture("beta"); f.deps.identity.mockRejectedValue(new Error("offline"));
    expect(await resolveRuntimeRelease({ ...f.input, cloudEnabled: false }, f.deps)).toEqual({ action: "skip", reason: "cloud_disabled" });
    expect(f.deps.identity).not.toHaveBeenCalled(); expect(f.deps.changes).not.toHaveBeenCalled();
  });
  it("publishes when the live Alpha pin has legacy null provenance", async () => {
    const f = fixture(); Object.assign(f.current, f.identity("alpha", false));
    expect(await resolveRuntimeRelease(f.input, f.deps)).toEqual({ action: "publish", reason: "unqualified", source_sha: source,
      expected_cp_sha: source, expected_runtime_sha256: previousDigest });
  });
  it.each(["pnpm-lock.yaml", "package.json", "catalogs/models.json", "patches/provider.patch", "packages/design-core/package.json",
    "apps/cloud-worker/src/worker.ts", "apps/cloud-worker/scripts/package-runtime.mjs", "packages/protocol/src/index.ts"])(
    "publishes for canonical runtime input %s", async path => {
      const f = fixture(); f.deps.changes.mockResolvedValue([path]);
      expect(await resolveRuntimeRelease(f.input, f.deps)).toMatchObject({ action: "publish", reason: "inputs_changed", source_sha: source });
    });
  it.each(["apps/control-plane/src/index.ts", "packages/protocol/README.md"])("refreshes qualification for %s even without archive input changes", async path => {
    const f = fixture(); f.deps.changes.mockResolvedValue([path]);
    expect(await resolveRuntimeRelease(f.input, f.deps)).toMatchObject({ action: "publish", reason: "qualification_changed" });
  });
  it("skips an unchanged qualified Alpha runtime for a desktop-only release", async () => {
    const f = fixture(); f.deps.changes.mockResolvedValue(["apps/desktop/src/renderer/app.tsx", "docs/guide.md"]);
    expect(await resolveRuntimeRelease(f.input, f.deps)).toEqual({ action: "skip", reason: "unchanged" });
    expect(f.deps.changes).toHaveBeenCalledExactlyOnceWith(previousSource, source);
  });
  it("republishes unchanged Alpha inputs when the prior enclosing release attempt failed", async () => {
    const f = fixture(); f.deps.published.mockResolvedValue(false);
    expect(await resolveRuntimeRelease(f.input, f.deps)).toMatchObject({ action: "publish", reason: "unqualified" });
  });
  it("refuses promotion when Alpha pin metadata names an incomplete publication", async () => {
    const f = fixture("beta"); f.deps.published.mockResolvedValue(false);
    await expect(resolveRuntimeRelease(f.input, f.deps)).rejects.toThrow(/publication/);
  });
  it("keeps unavailable publication evidence unknown instead of publishing or skipping", async () => {
    const f = fixture(); f.deps.published.mockRejectedValue(new Error("GitHub unavailable"));
    await expect(resolveRuntimeRelease(f.input, f.deps)).rejects.toThrow(/unavailable/);
  });
  it.each(["beta", "production"] as const)("promotes the qualified Alpha bytes to %s with both destination fences", async channel => {
    const f = fixture(channel);
    expect(await resolveRuntimeRelease(f.input, f.deps)).toEqual({ action: "promote", reason: "promotion", expected_cp_sha: source,
      expected_runtime_sha256: previousDigest, runtime_sha256: digest, alpha_run_id: "123", alpha_run_attempt: "2" });
    expect(f.deps.ancestor).toHaveBeenCalledExactlyOnceWith(previousSource, source);
  });
  it("skips only a matching pin with matching qualification metadata", async () => {
    const f = fixture("beta"); Object.assign(f.current, f.identity("beta"));
    expect(await resolveRuntimeRelease(f.input, f.deps)).toEqual({ action: "skip", reason: "current" });
    Object.assign(f.current, runtimeReleaseIdentity({ sha256: digest }));
    expect(await resolveRuntimeRelease(f.input, f.deps)).toMatchObject({ action: "promote", expected_runtime_sha256: digest });
  });
  it.each(["alpha", "beta", "production"] as const)("refuses destination drift on %s", async channel => {
    const f = fixture(channel); f.current.sourceSha = "3".repeat(40);
    await expect(resolveRuntimeRelease(f.input, f.deps)).rejects.toThrow(/destination/);
  });
  it.each(["alpha", "beta", "production"] as const)("refuses a newer or unrelated Alpha pin on %s", async channel => {
    const f = fixture(channel); f.deps.ancestor.mockResolvedValue(false);
    await expect(resolveRuntimeRelease(f.input, f.deps)).rejects.toThrow(/newer/);
  });
  it.each(["pnpm-lock.yaml", "apps/cloud-worker/src/worker.ts", "apps/control-plane/src/index.ts", "packages/protocol/README.md"])(
    "does not promote an ancestor whose runtime or qualifying input changed: %s", async path => {
      const f = fixture("beta"); f.deps.changes.mockResolvedValue([path]);
      await expect(resolveRuntimeRelease(f.input, f.deps)).rejects.toThrow(/differ/);
    });
  it.each(["legacy", "offline", "maintenance", "wrong-channel", "missing-worker"])("fails instead of a green skip for %s Alpha", async state => {
    const f = fixture("beta");
    if (state === "legacy") Object.assign(f.alpha, f.identity("alpha", false));
    if (state === "offline") f.deps.identity.mockRejectedValue(new Error("offline"));
    if (state === "maintenance") f.alpha.maintenance = true;
    if (state === "wrong-channel") f.alpha.channel = "production";
    if (state === "missing-worker") Object.assign(f.alpha, { worker: null });
    await expect(resolveRuntimeRelease(f.input, f.deps)).rejects.toThrow();
  });
});

describe("full runtime CI barrier", () => {
  it("waits for both exact sources and full CodeQL even when the Alpha gate has already passed", async () => {
    let ready = false;
    const config = { repository: "example/project", workflowSha: source, sourceSha: previousSource };
    const read = vi.fn(async (path: string) => {
      const file = path.includes("preflight.yml") ? "preflight.yml" : "codeql.yml", sha = new URL(`https://example.invalid${path}`).searchParams.get("head_sha");
      return { total_count: 1, workflow_runs: [{ id: 10, run_attempt: 1, path: `.github/workflows/${file}`, name: file === "preflight.yml" ? "Preflight" : "CodeQL",
        head_sha: sha, status: ready || sha === previousSource ? "completed" : "in_progress", conclusion: ready || sha === previousSource ? "success" : null,
        event: "push", repository: { full_name: config.repository }, head_repository: { full_name: config.repository } }] };
    });
    const sleep = vi.fn(async () => { ready = true; });
    await waitForRuntimeCI(config, read, { sleep, attempts: 2 });
    expect(sleep).toHaveBeenCalledOnce(); expect(read).toHaveBeenCalledTimes(8);
    expect(read.mock.calls.every(([path]) => /preflight\.yml|codeql\.yml/.test(path))).toBe(true);
  });
  it.each(["failure", "cancelled"])("stops as soon as exact-source Preflight concluded %s, instead of holding the Alpha lock", async conclusion => {
    const config = { repository: "example/project", workflowSha: source };
    const read = vi.fn(async (path: string) => {
      const file = path.includes("preflight.yml") ? "preflight.yml" : "codeql.yml";
      return { total_count: 1, workflow_runs: [{ id: 10, run_attempt: 2, path: `.github/workflows/${file}`, name: file === "preflight.yml" ? "Preflight" : "CodeQL",
        head_sha: source, status: file === "preflight.yml" ? "completed" : "in_progress", conclusion: file === "preflight.yml" ? conclusion : null,
        event: "push", repository: { full_name: config.repository }, head_repository: { full_name: config.repository } }] };
    });
    const sleep = vi.fn(async () => {});
    await expect(waitForRuntimeCI(config, read, { sleep, attempts: 660 })).rejects.toThrow(new RegExp(`Preflight run 10 attempt 2 concluded ${conclusion}`));
    expect(sleep).not.toHaveBeenCalled();
  });
  it("refuses missing full CI within a bounded wait", async () => {
    const read = vi.fn(async () => ({ total_count: 0, workflow_runs: [] })), sleep = vi.fn(async () => {});
    await expect(waitForRuntimeCI({ repository: "example/project", workflowSha: source }, read, { sleep, attempts: 2 })).rejects.toThrow(/timed out/);
    expect(read).toHaveBeenCalledTimes(4);
  });
});
