import { afterEach, describe, expect, it, vi } from "vitest";
import { assertBuildCapability, publicationGate } from "./publication";
import { channelBaseline, migrationManifest } from "./source";

const sha = "a".repeat(40), later = "b".repeat(40), digest = "c".repeat(64);
const candidate = { channel: "alpha" as const, sourceSha: sha, branch: "main", repository: "example/zeros", runId: "1", cloudRequired: true };
const backend = { version: 1, ready: true, sourceSha: sha, channel: "alpha", maintenance: false,
  migrations: { state: "current", head: "0112_test.sql", expectedHead: "0112_test.sql", manifestSha256: digest },
  cloud: { enabled: true, ready: true, state: "healthy" }, worker: null, workerQualified: false };
const receipt = { version: 1, status: "success", channel: "alpha", sourceSha: sha, branch: "main", repository: "example/zeros", runId: "1", runAttempt: "1",
  migration: { mode: "execute", database: "zeros-control-plane-alpha", branch: { name: "main", production: true }, backup: { id: "backup", state: "success" },
    controlledApprovals: [], pendingMigrations: [], applied: [], ledger: "verified", role: { deleted: true } }, backend,
  railwayDeploymentId: "deployment", pages: [{ id: "app", surface: "app" }, { id: "ops", surface: "ops" }], cloudRequired: true, completedAt: new Date().toISOString() };
const deps = () => ({ receipt: async () => receipt, identity: async () => backend,
  page: async (surface: string) => ({ version: 1, commitSha: sha, surface }) });

// Every channel allows cloud in the checked-in policy. A case pauses one
// channel here; the shared policy reads this object on every call.
const policy = vi.hoisted(() => ({ development: true, alpha: true, beta: true, production: true } as Record<string, boolean>));
vi.mock("../../apps/control-plane/src/cloud/channels.json", () => ({ default: policy }));

describe("V6 publication-time proof", () => {
  afterEach(() => { Object.assign(policy, { beta: true, production: true }); });

  it.each(["beta", "production"] as const)("requires the %s control plane to honor its cloud pause before publication", async channel => {
    policy[channel] = false;
    const config = { ...candidate, channel, branch: "release/1.2.3", cloudRequired: false };
    const paused = { ...backend, channel, cloud: { enabled: false, ready: true, state: "disabled" }, worker: null, workerQualified: false };
    const makeReceipt = (current: typeof paused | typeof backend) => ({ ...receipt, channel, branch: config.branch,
      cloudRequired: false, backend: current, pages: channel === "beta" ? [{ id: "app", surface: "app" }] : receipt.pages });
    await expect(publicationGate(config, { ...deps(), receipt: async () => makeReceipt(paused), identity: async () => paused })).resolves.toBeUndefined();
    for (const current of [{ ...backend, channel }]) {
      await expect(publicationGate(config, { ...deps(), receipt: async () => makeReceipt(current), identity: async () => current }))
        .rejects.toThrow(/channel.*paused/i);
    }
  });

  it.each(["beta", "production"] as const)("accepts the receipted %s cloud state once the channel allows cloud", async channel => {
    const config = { ...candidate, channel, branch: "release/1.2.3", cloudRequired: false };
    const paused = { ...backend, channel, cloud: { enabled: false, ready: true, state: "disabled" }, worker: null, workerQualified: false };
    for (const current of [paused, { ...backend, channel }]) {
      const currentReceipt = { ...receipt, channel, branch: config.branch, cloudRequired: false, backend: current,
        pages: channel === "beta" ? [{ id: "app", surface: "app" }] : receipt.pages };
      await expect(publicationGate(config, { ...deps(), receipt: async () => currentReceipt, identity: async () => current }))
        .resolves.toBeUndefined();
    }
  });

  it("allows a desktop-only retry while the channel remains in the receipted state", async () => {
    await expect(publicationGate(candidate, deps())).resolves.toBeUndefined();
  });
  it("refuses retry A after run B promoted another backend or Pages source", async () => {
    await expect(publicationGate(candidate, { ...deps(), identity: async () => ({ ...backend, sourceSha: later }) })).rejects.toThrow();
    await expect(publicationGate(candidate, { ...deps(), page: async surface => ({ version: 1, commitSha: later, surface }) })).rejects.toThrow();
  });
  it("refuses capability drift or another run's receipt", async () => {
    await expect(publicationGate(candidate, { ...deps(), identity: async () => ({ ...backend,
      cloud: { enabled: false, ready: true, state: "disabled" } }) })).rejects.toThrow();
    await expect(publicationGate(candidate, { ...deps(), receipt: async () => ({ ...receipt, runId: "2" }) })).rejects.toThrow();
  });
  it("refuses a receipt made under another desktop cloud decision", async () => {
    await expect(publicationGate({ ...candidate, cloudRequired: false }, deps())).rejects.toThrow("desktop cloud capability");
    const { cloudRequired: _omitted, ...legacy } = receipt;
    await expect(publicationGate(candidate, { ...deps(), receipt: async () => legacy })).rejects.toThrow("desktop cloud capability");
  });
  it("publishes only the cloud capability the signed build baked in", () => {
    expect(() => assertBuildCapability("false", false)).not.toThrow();
    expect(() => assertBuildCapability("true", true)).not.toThrow();
    for (const [built, required] of [["true", false], ["false", true], [undefined, false], ["", false], ["yes", true]] as const)
      expect(() => assertBuildCapability(built, required)).toThrow("signed desktop");
  });
  it("publishes v2 cloud with source, Pages and receipt checks and no image qualification", async () => {
    await expect(publicationGate(candidate, deps())).resolves.toBeUndefined();
    expect(backend.worker).toBeNull();
    expect(backend.workerQualified).toBe(false);
  });
});

describe("published channel baselines", () => {
  it("resolves rolling Alpha/Beta tags and the numerically highest stable v tag to commits", async () => {
    const calls: string[][] = [];
    const run = async (_file: string, args: string[]) => { calls.push(args); return args[0] === "for-each-ref" ? "alpha\nbeta\nv1.9.9\nv1.10.0\nv1.10.0-beta.2\n" : `${sha}\n`; };
    for (const [channel, tag] of [["alpha", "alpha"], ["beta", "beta"], ["production", "v1.10.0"]] as const) {
      expect(await channelBaseline(channel, run)).toEqual({ tag, sourceSha: sha });
      expect(calls.at(-1)).toContain(`refs/tags/${tag}^{commit}`);
    }
    expect(await channelBaseline("production", async () => "")).toBeNull();
  });
  it("hashes the committed migration names and bytes, even when the working tree was rewritten for packaging", async () => {
    const rows = [{ name: "0001_initial.sql", checksum: "" }];
    const run = async (_file: string, args: string[]) => args[0] === "ls-tree" ? `100644 blob ${later}\tapps/control-plane/migrations/${rows[0].name}\0` : "SELECT 1;\n";
    const manifest = await migrationManifest(sha, run);
    const changed = await migrationManifest(sha, async (file, args) => args[0] === "cat-file" ? "SELECT 2;\n" : run(file, args));
    expect(manifest.head).toBe(rows[0].name); expect(manifest.sha256).not.toBe(changed.sha256);
  });
});
