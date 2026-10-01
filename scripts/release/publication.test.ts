import { describe, expect, it } from "vitest";
import { publicationGate } from "./publication";
import { reusableWorker } from "./worker-reuse";
import { channelBaseline, migrationManifest } from "./source";

const sha = "a".repeat(40), later = "b".repeat(40), digest = "c".repeat(64);
const candidate = { channel: "alpha" as const, sourceSha: sha, branch: "main", repository: "example/zeros", runId: "1", cloudRequired: true, provider: "boat" };
const worker = { provider: "boat", imageRef: `boat:zeros-alpha-fixture@sha256:${digest}`, sourceSha: sha, architecture: "linux/amd64", storageMiB: 4096 };
const backend = { version: 1, ready: true, sourceSha: sha, channel: "alpha", maintenance: false,
  migrations: { state: "current", head: "0112_test.sql", expectedHead: "0112_test.sql", manifestSha256: digest },
  cloud: { enabled: true, ready: true, state: "healthy" }, worker, workerQualified: true };
const receipt = { version: 1, status: "success", channel: "alpha", sourceSha: sha, branch: "main", repository: "example/zeros", runId: "1", runAttempt: "1",
  migration: { mode: "execute", database: "zeros-control-plane-alpha", branch: { name: "main", production: true }, backup: { id: "backup", state: "success" },
    controlledApprovals: [], pendingMigrations: [], applied: [], ledger: "verified", role: { deleted: true } }, backend,
  railwayDeploymentId: "deployment", pages: [{ id: "app", surface: "app" }, { id: "ops", surface: "ops" }], completedAt: new Date().toISOString() };
const deps = () => ({ receipt: async () => receipt, identity: async () => backend,
  page: async (surface: string) => ({ version: 1, commitSha: sha, surface }) });

describe("V6 publication-time proof", () => {
  it("allows a desktop-only retry while the channel remains in the receipted state", async () => {
    await expect(publicationGate(candidate, deps())).resolves.toBeUndefined();
  });
  it("refuses retry A after run B promoted another backend or Pages source", async () => {
    await expect(publicationGate(candidate, { ...deps(), identity: async () => ({ ...backend, sourceSha: later }) })).rejects.toThrow();
    await expect(publicationGate(candidate, { ...deps(), page: async surface => ({ version: 1, commitSha: later, surface }) })).rejects.toThrow();
  });
  it("refuses revoked approval, a different complete worker tuple, and another run's receipt", async () => {
    for (const patch of [{ workerQualified: false }, { workerQualified: undefined }, { worker: { ...worker, storageMiB: 8192 } }])
      await expect(publicationGate(candidate, { ...deps(), identity: async () => ({ ...backend, ...patch }) })).rejects.toThrow();
    await expect(publicationGate(candidate, { ...deps(), receipt: async () => ({ ...receipt, runId: "2" }) })).rejects.toThrow();
  });
  it("a cloud-disabled desktop needs no worker, even beside an API running unqualified cloud", async () => {
    const desktop = { ...candidate, cloudRequired: false, provider: undefined };
    const unqualified = { ...backend, workerQualified: false, worker: { ...worker, sourceSha: later } };
    const hash = async (source: string) => source === sha ? digest : "d".repeat(64);
    expect(await reusableWorker(desktop, unqualified, hash)).toBeUndefined();
    await expect(reusableWorker(desktop, { ...backend, channel: "beta" }, hash)).rejects.toThrow("Current channel readiness is unavailable");
  });
  it("enabled reuse requires affirmative current qualification", async () => {
    for (const workerQualified of [false, undefined])
      await expect(reusableWorker(candidate, { ...backend, workerQualified }, async () => digest)).rejects.toThrow();
    expect(await reusableWorker(candidate, backend, async () => digest)).toEqual(worker);
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
