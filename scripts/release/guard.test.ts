import { describe, expect, it, vi } from "vitest";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { disabledGuard, hostedWorkerPromotionRequired, publicIdentity } from "./guard";
import { classifyChanges } from "./source";
import { githubClient, validateBetaReceipt } from "./github";
const sha = "a".repeat(40);
function receipt() { return { version: 1, status: "success", channel: "beta", sourceSha: sha, branch: "release/1.2.3", repository: "example/zeros", runId: "1", runAttempt: "1",
  migration: { mode: "execute", database: "zeros-control-plane-beta", branch: { name: "main", production: true }, backup: { id: "backup", state: "success" },
    controlledApprovals: [], pendingMigrations: [], applied: [], ledger: "verified", role: { deleted: true } }, railwayDeploymentId: "deployment",
  backend: { version: 1, ready: true, sourceSha: sha, channel: "beta", maintenance: false,
    migrations: { state: "current", head: "0112_test.sql", expectedHead: "0112_test.sql", manifestSha256: "b".repeat(64) },
    cloud: { enabled: false, ready: true, state: "disabled" }, worker: null },
  pages: [{ id: "pages", surface: "app" }], completedAt: new Date().toISOString() }; }
const run = { id: 1, run_attempt: 1, conclusion: "success", event: "push", head_sha: sha, head_branch: "release/1.2.3", path: ".github/workflows/release-beta.yml", repository: { full_name: "example/zeros" } };
const config = { sourceSha: sha, branch: "release/1.2.3", repository: "example/zeros" };
describe("rollout and promotion evidence", () => {
  it.each(["alpha", "beta", "production"] as const)("withholds a valid %s identity on HTTP 503", async channel => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ ...liveIdentity(), channel }, { status: 503 }));
    expect(await publicIdentity(channel, fetcher)).toEqual({ present: true, identity: null });
  });
  it("never silently labels a disabled rollout successful", async () => {
    const unchanged = fakeIdentity(null); unchanged.migrationManifest.mockResolvedValue(manifest);
    expect(await disabledGuard(["docs/example.md"], candidate, unchanged)).toMatchObject({ blocked: false, message: expect.stringContaining("DISABLED") });
    expect(await disabledGuard([migrationFile], candidate, fakeIdentity(null))).toMatchObject({ blocked: true, migrations: true });
    for (const path of ["apps/desktop/src/engine/index.ts", "pnpm-lock.yaml", "scripts/cloud-workspace-validation/config.ts", "packages/protocol/src/index.ts"])
      expect(classifyChanges([path]).worker).toBe(true);
    expect(classifyChanges(["apps/desktop/src/renderer/index.tsx"]).worker).toBe(false);
  });
  it("accepts only the successful exact-SHA Beta workflow's own receipt", () => {
    expect(validateBetaReceipt(receipt(), run, config, hostedJobs).channel).toBe("beta");
    for (const patch of [{ conclusion: "failure" }, { head_sha: "c".repeat(40) }, { path: ".github/workflows/other.yml" }, { event: "pull_request" }, { run_attempt: 0 }])
      expect(() => validateBetaReceipt(receipt(), { ...run, ...patch }, config, hostedJobs)).toThrow();
    for (const patch of [{ channel: "alpha" }, { sourceSha: "c".repeat(40) }, { status: "disabled" }, { pages: [] }, { runId: "2" }])
      expect(() => validateBetaReceipt({ ...receipt(), ...patch }, run, config, hostedJobs)).toThrow();
  });
  it("refuses candidate publication from a ready rollback identity ahead of its packaged head", async () => {
    const identity = liveIdentity(), aheadManifest = { head: "0113_future_expand.sql", sha256: "e".repeat(64) };
    identity.sourceSha = baselineSha;
    identity.migrations.head = aheadManifest.head;
    const deps = fakeIdentity(identity);
    deps.migrationManifest.mockImplementation(async source => source === baselineSha ? manifest : aheadManifest);
    expect(await publicIdentity("alpha", deps.fetch)).toEqual({ present: true, identity: null });
    expect(await disabledGuard(["apps/control-plane/migrations/0113_future_expand.sql"], candidate, deps))
      .toMatchObject({ blocked: true, migrations: true, manualCutoverVerified: false });
    expect(deps.cutoverReceipt).not.toHaveBeenCalled();
  });
});

const candidate = { channel: "alpha" as const, sourceSha: sha, cloudEnabled: false, provider: "boat" };
const migrationFile = "apps/control-plane/migrations/0112_test.sql";
const workerFile = "apps/desktop/src/engine/index.ts";
const manifest = { head: "0112_test.sql", sha256: "b".repeat(64) };
const baselineSha = "1".repeat(40);
const hostedJobs = [{ run_id: 1, run_attempt: 1, head_sha: sha, name: "Hosted promotion (beta) / Hosted mutation", status: "completed", conclusion: "success",
  steps: [{ name: "Provider preflight and ordered promotion", conclusion: "success" }, { name: "Save success receipt", conclusion: "success" }] }];
function liveIdentity() { return { ...receipt().backend, channel: "alpha", workerQualified: true,
  cloud: { enabled: true, ready: true, state: "healthy" },
  worker: { provider: "boat", imageRef: `boat:zeros-alpha-fixture@sha256:${"c".repeat(64)}`, sourceSha: sha, architecture: "linux/amd64", storageMiB: 4096 } }; }
function fakeIdentity(value: unknown, pagesSha?: string, receipt = true) {
  return { fetch: vi.fn<typeof fetch>(async input => String(input).endsWith("/zeros-deployment.json")
      ? Response.json({ version: 1, commitSha: pagesSha ?? (value as { sourceSha?: string } | null)?.sourceSha,
        surface: new URL(String(input)).hostname.startsWith("ops") ? "ops" : "app" })
      : value === null ? new Response("missing", { status: 404 }) : Response.json(value)),
    cutoverReceipt: vi.fn(async () => receipt),
    channelBaseline: async () => ({ tag: "alpha", sourceSha: baselineSha }),
    migrationManifest: vi.fn(async (source?: string) => source === baselineSha ? { head: "0111_test.sql", sha256: "1".repeat(64) } : manifest),
    workerInputsSha256: vi.fn(async (source: string) => (source === baselineSha ? "f" : "d").repeat(64)) };
}
describe("enabled worker lane selection", () => {
  it("does not inspect or rebuild a worker when the execution switch is disabled", async () => {
    const deps = fakeIdentity(null);
    expect(await hostedWorkerPromotionRequired(false, candidate, deps)).toBe(false);
    expect(deps.fetch).not.toHaveBeenCalled();
    expect(deps.workerInputsSha256).not.toHaveBeenCalled();
  });
  it("reuses an older qualified image with the exact same committed worker input tree", async () => {
    const identity = liveIdentity(); identity.worker.sourceSha = baselineSha;
    const deps = fakeIdentity(identity); deps.workerInputsSha256.mockResolvedValue("d".repeat(64));
    expect(await hostedWorkerPromotionRequired(true, candidate, deps)).toBe(false);
    expect(deps.workerInputsSha256).toHaveBeenCalledWith(baselineSha);
    expect(deps.workerInputsSha256).toHaveBeenCalledWith(sha);
  });
  it("selects native qualification when selected inputs differ or their hash cannot be verified", async () => {
    const identity = liveIdentity(); identity.worker.sourceSha = baselineSha;
    const deps = fakeIdentity(identity);
    expect(await hostedWorkerPromotionRequired(true, candidate, deps)).toBe(true);
    deps.workerInputsSha256.mockRejectedValue(new Error("private-git-detail"));
    expect(await hostedWorkerPromotionRequired(true, candidate, deps)).toBe(true);
  });
  it("never skips an enabled lane on absent, unqualified, cross-channel or wrong-provider identity", async () => {
    for (const identity of [null, { ...liveIdentity(), workerQualified: false }, { ...liveIdentity(), channel: "beta" },
      { ...liveIdentity(), worker: { ...liveIdentity().worker, provider: "daytona" } }])
      expect(await hostedWorkerPromotionRequired(true, candidate, fakeIdentity(identity))).toBe(true);
  });
});
describe("disabled promotion guard", () => {
  it("allows ordinary engine edits with cloud off and unchanged published schema when the API is absent", async () => {
    const deps = fakeIdentity(null);
    deps.migrationManifest.mockResolvedValue(manifest);
    const result = await disabledGuard([workerFile], candidate, deps);
    expect(result).toMatchObject({ blocked: false, worker: true });
    expect(result.message).toContain("cloud-enabled desktop: no");
    expect(result.message).toContain("Legacy desktop publication may proceed");
    expect(deps.fetch).toHaveBeenCalledOnce();
  });
  it("blocks cloud-enabled engine edits without a qualified matching live worker", async () => {
    for (const patch of [null, { workerQualified: false }, { workerQualified: undefined }, { worker: null },
      { ready: false }, { channel: "beta" }, { maintenance: true }, { cloud: { enabled: false, ready: true, state: "disabled" } }]) {
      const deps = fakeIdentity(patch === null ? null : { ...liveIdentity(), ...patch });
      expect(await disabledGuard([workerFile], { ...candidate, cloudEnabled: true }, deps)).toMatchObject({ blocked: true, workerVerified: false });
    }
  });
  it("accepts a qualified live worker from the candidate or an identical committed input tree", async () => {
    for (const sourceSha of [sha, "e".repeat(40)]) {
      const identity = liveIdentity(); identity.worker.sourceSha = sourceSha;
      const result = await disabledGuard([workerFile], { ...candidate, cloudEnabled: true }, fakeIdentity(identity));
      expect(result).toMatchObject({ blocked: false, workerVerified: true });
    }
  });
  it("rejects a different worker provider, changed worker inputs, or unmeasurable worker history", async () => {
    const identity = liveIdentity(); identity.worker.sourceSha = "e".repeat(40);
    const different = fakeIdentity(identity);
    different.workerInputsSha256.mockImplementation(async source => source);
    expect(await disabledGuard([workerFile], { ...candidate, cloudEnabled: true }, different)).toMatchObject({ blocked: true });
    const unavailable = fakeIdentity(identity);
    unavailable.workerInputsSha256.mockRejectedValue(new Error("private-provider-message"));
    const result = await disabledGuard([workerFile], { ...candidate, cloudEnabled: true }, unavailable);
    expect(result.blocked).toBe(true); expect(result.message).not.toContain("private-provider-message");
    expect(await disabledGuard([workerFile], { ...candidate, cloudEnabled: true, provider: "daytona" }, fakeIdentity(liveIdentity()))).toMatchObject({ blocked: true });
  });
  it("unblocks a rerun after the exact candidate backend was deployed manually", async () => {
    const identity = liveIdentity(); identity.migrations.manifestSha256 = "f".repeat(64);
    const deps = fakeIdentity(identity), result = await disabledGuard([migrationFile, workerFile], candidate, deps);
    expect(result).toMatchObject({ blocked: false, manualCutoverVerified: true });
    expect(result.message).toContain("manual cutover verified");
    expect(deps.fetch).toHaveBeenCalledWith("https://api-alpha.zeros.build/v1/release-identity", expect.objectContaining({
      method: "GET", credentials: "omit", redirect: "error", cache: "no-store", signal: expect.any(AbortSignal) }));
    expect(new Headers(deps.fetch.mock.calls[0][1]?.headers).has("authorization")).toBe(false);
  });
  it("keeps a schema cutover blocked until every Pages surface serves the cut-over API's commit", async () => {
    const identity = liveIdentity(); identity.migrations.manifestSha256 = "f".repeat(64);
    const stale = await disabledGuard([migrationFile], candidate, fakeIdentity(identity, "9".repeat(40)));
    expect(stale).toMatchObject({ blocked: true, manualCutoverVerified: false });
    expect(stale.message).toContain("finish the cutover's Pages upload before publication");
    const deps = fakeIdentity(identity);
    expect(await disabledGuard([migrationFile], candidate, deps)).toMatchObject({ blocked: false, manualCutoverVerified: true });
    expect(deps.fetch.mock.calls.map(call => String(call[0]))).toEqual(["https://api-alpha.zeros.build/v1/release-identity",
      "https://app-alpha.zeros.build/zeros-deployment.json", "https://ops-alpha.zeros.build/zeros-deployment.json"]);
  });
  it("requires the controlled-cutover workflow's own receipt for the cut-over commit", async () => {
    const identity = liveIdentity(); identity.migrations.manifestSha256 = "f".repeat(64);
    const deps = fakeIdentity(identity, undefined, false);
    const result = await disabledGuard([migrationFile], candidate, deps);
    expect(result).toMatchObject({ blocked: true, manualCutoverVerified: false });
    expect(result.message).toContain(`No successful controlled-cutover receipt exists for ${identity.sourceSha}`);
    expect(deps.cutoverReceipt).toHaveBeenCalledWith("alpha", identity.sourceSha, identity.migrations.manifestSha256);
  });
  it("requires the same completion proof when the published baseline is unknown", async () => {
    const without = { ...fakeIdentity(liveIdentity(), undefined, false), channelBaseline: async () => null };
    expect(await disabledGuard([], candidate, without)).toMatchObject({ blocked: true, manualCutoverVerified: false });
    const withProof = { ...fakeIdentity(liveIdentity()), channelBaseline: async () => null };
    expect(await disabledGuard([], candidate, withProof)).toMatchObject({ blocked: false, manualCutoverVerified: true });
  });
  it("refuses a Pages manifest for the wrong surface", async () => {
    const identity = liveIdentity(); identity.migrations.manifestSha256 = "f".repeat(64);
    const deps = fakeIdentity(identity);
    deps.fetch.mockImplementation(async input => String(input).endsWith("/zeros-deployment.json")
      ? Response.json({ version: 1, commitSha: identity.sourceSha, surface: "app" }) : Response.json(identity));
    expect(await disabledGuard([migrationFile], candidate, deps)).toMatchObject({ blocked: true, manualCutoverVerified: false });
  });
  it("does not consult Pages when the published schema is unchanged", async () => {
    const deps = fakeIdentity(liveIdentity(), "9".repeat(40));
    deps.migrationManifest = vi.fn(async () => manifest);
    expect(await disabledGuard([], candidate, deps)).toMatchObject({ blocked: false });
    expect(deps.fetch.mock.calls.some(call => String(call[0]).endsWith("/zeros-deployment.json"))).toBe(false);
    expect(deps.cutoverReceipt).not.toHaveBeenCalled();
  });
  it("accepts a different backend SHA only when the full candidate migration manifest is current", async () => {
    const identity = { ...liveIdentity(), sourceSha: "e".repeat(40) };
    expect(await disabledGuard([migrationFile], candidate, fakeIdentity(identity))).toMatchObject({ blocked: false, manualCutoverVerified: true });
    for (const migrations of [{ ...identity.migrations, state: "pending" }, { ...identity.migrations, state: "controlled" },
      { ...identity.migrations, expectedHead: "0111_test.sql" }, { ...identity.migrations, manifestSha256: "f".repeat(64) }]) {
      expect(await disabledGuard([migrationFile], candidate, fakeIdentity({ ...identity, migrations }))).toMatchObject({ blocked: true });
    }
  });
  it("fails closed on absent, malformed, wrong-channel or unready identities with exact operator steps", async () => {
    for (const identity of [null, {}, { ...liveIdentity(), version: 2 }, { ...liveIdentity(), channel: "beta" },
      { ...liveIdentity(), maintenance: true }, { ...liveIdentity(), ready: false },
      { ...liveIdentity(), migrations: { ...liveIdentity().migrations, state: "pending" } }]) {
      const result = await disabledGuard([migrationFile], candidate, fakeIdentity(identity));
      expect(result.blocked).toBe(true);
      expect(result.message).toContain(`dispatch controlled-cutover.yml for alpha`);
      expect(result.message).toContain(`at ${sha}`);
      expect(result.message).toContain("confirm=zeros-control-plane-alpha");
      expect(result.message).toContain("backs up and migrates");
      expect(result.message).toContain("re-run the failed Release (alpha) workflow");
    }
  });
  it("does not let migration proof bypass an unqualified worker for a cloud-enabled desktop", async () => {
    expect(await disabledGuard([migrationFile, workerFile], { ...candidate, cloudEnabled: true },
      fakeIdentity({ ...liveIdentity(), workerQualified: false }))).toMatchObject({ blocked: true, manualCutoverVerified: true, workerVerified: false });
  });
  it("uses each channel's fixed public origin without provider authority", async () => {
    for (const channel of ["alpha", "beta", "production"] as const) {
      const deps = fakeIdentity({ ...liveIdentity(), channel });
      expect((await disabledGuard([migrationFile], { ...candidate, channel }, deps)).blocked).toBe(false);
      expect(deps.fetch.mock.calls[0][0]).toBe(`https://api${channel === "production" ? "" : `-${channel}`}.zeros.build/v1/release-identity`);
    }
  });
  it("bounds a stalled public read to five seconds and withholds private errors", async () => {
    vi.useFakeTimers();
    try {
      const deps = fakeIdentity(null);
      deps.fetch.mockImplementation(() => new Promise(() => {}));
      const pending = disabledGuard([migrationFile], candidate, deps);
      await vi.advanceTimersByTimeAsync(5_001);
      expect(await pending).toMatchObject({ blocked: true });
      expect(deps.fetch.mock.calls[0][1]?.signal?.aborted).toBe(true);
    } finally { vi.useRealTimers(); }
    const deps = fakeIdentity(null); deps.fetch.mockRejectedValue(new Error("private-http-error"));
    expect((await disabledGuard([migrationFile], candidate, deps)).message).not.toContain("private-http-error");
  });
});

describe("V6 channel history regressions", () => {
  const baseSha = "1".repeat(40), nextSha = "2".repeat(40);
  const old = { head: "0111_test.sql", sha256: "1".repeat(64) };
  function history(schemaChanged = false) {
    return { ...fakeIdentity(null), channelBaseline: async () => ({ tag: "alpha", sourceSha: baseSha }),
      workerInputsSha256: vi.fn(async (_source: string) => "d".repeat(64)),
      migrationManifest: async (source?: string) => source === baseSha && schemaChanged ? old : manifest };
  }
  it.each([["dispatch", "production"], ["first-push", "beta"]] as const)("allows %s with no endpoint when the published channel schema is unchanged", async (_event, channel) => {
    expect(await disabledGuard([migrationFile, workerFile], { ...candidate, channel }, history())).toMatchObject({ blocked: false, migrations: false });
    expect((await disabledGuard([migrationFile, workerFile], { ...candidate, channel }, history(true))).blocked).toBe(true);
  });
  it("keeps an unresolved migration blocking across a later docs-only push or displaced pending run", async () => {
    const deps = history(true);
    expect((await disabledGuard([migrationFile], candidate, deps)).blocked).toBe(true);
    expect((await disabledGuard(["docs/readme.md"], { ...candidate, sourceSha: nextSha }, deps)).blocked).toBe(true);
    // Same descendant is checked at publication even if the earlier run never ran.
    expect((await disabledGuard([], { ...candidate, sourceSha: nextSha }, deps)).blocked).toBe(true);
  });
  it("detects checksum-only schema changes rather than trusting a matching head", async () => {
    const deps = history(); deps.migrationManifest = async source => source === baseSha ? { ...manifest, sha256: "f".repeat(64) } : manifest;
    expect((await disabledGuard([], candidate, deps)).blocked).toBe(true);
  });
  it("blocks without any channel baseline or answering identity", async () => {
    expect(await disabledGuard([], candidate, { ...history(), channelBaseline: async () => null })).toMatchObject({ blocked: true });
    expect(await disabledGuard([], candidate, { ...fakeIdentity(liveIdentity()), channelBaseline: async () => null })).toMatchObject({ blocked: false, manualCutoverVerified: true });
  });
  it("prefers live schema state over a matching release tag", async () => {
    const deps = history(); deps.fetch.mockResolvedValue(Response.json({ ...liveIdentity(), sourceSha: baseSha, migrations: { ...liveIdentity().migrations, expectedHead: old.head, head: old.head, manifestSha256: old.sha256 } }));
    expect((await disabledGuard([], candidate, deps)).blocked).toBe(true);
  });
  it("keeps an unresolved worker contract across descendant pushes for cloud-enabled desktops", async () => {
    const deps = history(); deps.workerInputsSha256.mockImplementation(async source => source === baseSha ? "f".repeat(64) : "d".repeat(64));
    expect((await disabledGuard([], { ...candidate, cloudEnabled: true }, deps)).blocked).toBe(true);
    expect((await disabledGuard(["docs/readme.md"], { ...candidate, sourceSha: nextSha, cloudEnabled: true }, deps)).blocked).toBe(true);
    expect((await disabledGuard([], candidate, deps)).blocked).toBe(false);
  });
  it("accepts Beta's earlier hosted attempt only with that attempt's successful hosted job", () => {
    const jobs = [{ run_id: 1, run_attempt: 1, head_sha: sha, name: "Hosted promotion (beta) / Hosted mutation", status: "completed", conclusion: "success",
      steps: [{ name: "Provider preflight and ordered promotion", conclusion: "success" }, { name: "Save success receipt", conclusion: "success" }] }];
    expect(validateBetaReceipt(receipt(), { ...run, run_attempt: 2 }, config, jobs).runAttempt).toBe("1");
    for (const patch of [{ conclusion: "failure" }, { run_attempt: 2 }, { head_sha: nextSha }, { run_id: 2 }, { name: "test" }]) {
      expect(() => validateBetaReceipt(receipt(), { ...run, run_attempt: 2 }, config, [{ ...jobs[0], ...patch }])).toThrow();
    }
    expect(validateBetaReceipt({ ...receipt(), runAttempt: "2" }, { ...run, run_attempt: 2 }, config, [{ ...jobs[0], run_attempt: 2 }]).runAttempt).toBe("2");
  });
  it.each(["1", "2"])("fetches hosted evidence from recorded attempt %s, not the latest merged job list", async attempt => {
    const routes: string[] = [], downloaded = { ...receipt(), runAttempt: attempt };
    const client = githubClient(config, { GH_TOKEN: "fake-token" }, {
      fetch: async input => {
        const route = String(input); routes.push(route);
        if (route.includes("/workflows/")) return Response.json({ workflow_runs: [{ ...run, run_attempt: 2 }] });
        if (route.includes("/artifacts?")) return Response.json({ artifacts: [{ name: `hosted-promotion-beta-${sha}`, expired: false, workflow_run: { head_sha: sha } }] });
        if (route.includes(`/attempts/${attempt}/jobs?`)) return Response.json({ jobs: [{ ...hostedJobs[0], run_attempt: undefined }] });
        throw new Error("Unexpected API route");
      },
      command: async (file, args, options) => {
        expect(file).toBe("gh"); expect(args).not.toContain("fake-token"); expect(options?.env?.GH_TOKEN).toBe("fake-token");
        await writeFile(path.join(args[args.indexOf("--dir") + 1], "hosted-receipt.json"), JSON.stringify(downloaded));
        return "";
      },
    });
    expect((await client.betaReceipt()).runAttempt).toBe(attempt);
    expect(routes.filter(route => route.includes("/jobs?"))).toEqual([`https://api.github.com/repos/example/zeros/actions/runs/1/attempts/${attempt}/jobs?per_page=100&page=1`]);
    expect(() => validateBetaReceipt(downloaded, { ...run, run_attempt: 2 }, config, [])).toThrow();
    expect(() => validateBetaReceipt(downloaded, { ...run, run_attempt: 2 }, config, [{ ...hostedJobs[0], run_attempt: Number(attempt), steps: [] }])).toThrow();
  });
});
