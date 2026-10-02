import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { releaseCanaryAdapter, fixedCanaryOutcome } from "./worker-canary";
import { releaseCanaryBroker, releaseCanaryConnections, ReleaseCanaryPrelaunchError } from "./worker-broker";
import { SMOKE_MODELS } from "./worker-profile";
import { workerEnvironment, workerConnections } from "./worker-test-fixtures";
import { workerExecutionConfig } from "./worker-config";
import { PromotionError } from "./contracts";

const image = { snapshotId: "worker-test", sourceCommit: "a".repeat(40), buildSha256: "b".repeat(64), architecture: "linux/amd64" as const, storageMiB: 4096 };
const targetFor = () => ({ id: "bx_test", attempt: randomUUID(), snapshotId: image.snapshotId, sourceCommit: image.sourceCommit, buildSha256: image.buildSha256 });
const environment = workerEnvironment;
const connectionsFor = (profile: "smoke" | "full" = "smoke") => releaseCanaryConnections(workerConnections(), profile);
const leaseFor = () => ({ state: { resources: { images: [] as any[] } }, save: vi.fn(async () => {}), fence: vi.fn(async () => {}) });
const runFor = () => ({ runId: "123", canaries: [] });

describe("protected metadata-only release canary broker", () => {
  it("reports only allowlisted missing/ambiguous kinds and withholds every other server diagnostic", async () => {
    const env = environment(), config = workerExecutionConfig(env).config;
    for (const message of ["Release canary designation missing for codex-chatgpt", "Release canary designation ambiguous for cursor-api-key"]) {
      const fetcher = vi.fn(async () => new Response(JSON.stringify({ error: { code: "release_canary_unavailable", message } }), { status: 409 }));
      await expect(releaseCanaryBroker(config, env, "smoke", fetcher as any).preflight()).rejects.toThrow(message);
      expect(fetcher).toHaveBeenCalledOnce();
    }
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ error: { code: "release_canary_unavailable", message: "synthetic-private-diagnostic" } }), { status: 500 }));
    await expect(releaseCanaryBroker(config, env, "smoke", fetcher as any).preflight()).rejects.toThrow("unconfirmed");
  });
  it("refuses discovery for another actor, source or recorded run attempt before dispatch", async () => {
    const env = environment(), config = workerExecutionConfig(env).config;
    for (const changed of [{ ownerUserId: workerConnections()[0]!.credentialId }, { sourceSha: "b".repeat(40) }, { runAttempt: "2" }, { material: "synthetic-never-accepted" }]) {
      const fetcher = vi.fn(async (_url: any, options: any) => new Response(JSON.stringify({ ...JSON.parse(options.body), ready: true, connections: workerConnections(), ...changed })));
      const broker = releaseCanaryBroker(config, env, "smoke", fetcher as any);
      await expect(broker.preflight()).rejects.toThrow("exact API and run");
      await expect(broker.start({ attempt: randomUUID() }, "codex-chatgpt")).rejects.toThrow("discovery is required");
      expect(fetcher).toHaveBeenCalledOnce();
    }
  });
  it("requires exactly the opted-in three kinds and never loads provider secrets", () => {
    const connections = connectionsFor();
    expect([...connections.keys()]).toEqual(["claude-setup-token", "codex-chatgpt", "cursor-api-key"]);
    expect(connections.get("codex-chatgpt")).not.toHaveProperty("material");
    const document = workerConnections();
    for (const connections of [document.slice(1), [...document, { ...document[0], kind: "claude-api-key" }],
      document.map(row => ({ ...row, material: { accessToken: "synthetic-never-accepted" } }))]) {
      expect(() => releaseCanaryConnections(connections, "smoke")).toThrow();
    }
    const env = environment();
    expect(() => releaseCanaryBroker(workerExecutionConfig(env).config, { ...env, WORKER_CANARY_ADMISSION_TOKEN: "" }, "smoke")).toThrow("authority");
  });
  it("binds preflight and dispatch to the new channel API and sends no account material to CI", async () => {
    const env = environment(), config = workerExecutionConfig(env).config, calls: any[] = [];
    const fetcher = vi.fn(async (url: any, options: any) => {
      calls.push({ url, ...JSON.parse(options.body) });
      expect(options.redirect).toBe("error");
      return new Response(JSON.stringify(url.endsWith("preflight") ? { ready: true, ...JSON.parse(options.body), connections: workerConnections() } : { started: true }));
    });
    const broker = releaseCanaryBroker(config, env, "smoke", fetcher as any);
    await broker.preflight(); await broker.start(targetFor(), "codex-chatgpt");
    expect(calls).toHaveLength(2); expect(calls[1]).toMatchObject({ kind: "codex-chatgpt", runId: "123", runAttempt: "1", sourceSha: image.sourceCommit });
    expect(JSON.stringify(calls)).not.toContain(env.WORKER_CANARY_ADMISSION_TOKEN);
    expect(calls[1]).not.toHaveProperty("material");
    expect(calls[0]).not.toHaveProperty("connections");
    expect(calls[1]).toMatchObject({ credentialId: workerConnections()[1]!.credentialId, credentialRevision: 1, designationId: "41" });
  });
  it("does not retry lost admission responses or expose provider/token text", async () => {
    const env = environment(), fetcher = vi.fn(async (_url: any, options: any) => {
      if (fetcher.mock.calls.length === 1) return new Response(JSON.stringify({ ready: true, ...JSON.parse(options.body), connections: workerConnections() }));
      throw new Error("synthetic-private-response");
    });
    const broker = releaseCanaryBroker(workerExecutionConfig(env).config, env, "smoke", fetcher as any);
    await broker.preflight();
    await expect(broker.start(targetFor(), "codex-chatgpt")).rejects.toThrow("reconcile");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("retains only fixed allowlisted proof, not provider output or credential-shaped fields", () => {
    const privateText = "syntheticPrivateProviderText";
    const result = fixedCanaryOutcome({ code: 1, retirement: 0, stdout: privateText, renewal: { privateText },
      report: { checks: ["nativeTurn", privateText], authority: privateText, executionProfile: privateText,
        identity: { kind: privateText, model: privateText }, failureKind: "rate-limited", failureMessage: privateText } }, { kind: "cursor-api-key", model: SMOKE_MODELS.cursor, image });
    expect(JSON.stringify(result)).not.toContain(privateText);
    expect(result.report.checks).toEqual(["nativeTurn"]); expect(result.report.failureKind).toBe("rate-limited");
  });
});

describe("release VM canary coordination", () => {
  it.each(["forbidden", "uncertain"])("stops a %s startup failure without polling, replaying or inventing an outcome", async reason => {
    const lease = leaseFor(), run: any = runFor(), pause = vi.fn(async () => {});
    const core = { allocate: vi.fn(async () => {}), ready: vi.fn(async () => true),
      start: vi.fn(async () => { throw reason === "forbidden"
        ? new ReleaseCanaryPrelaunchError()
        : new Error("synthetic-private-start-diagnostic"); }),
      poll: vi.fn(async () => ({ running: true })), retire: vi.fn(async () => {}) };
    const adapter = releaseCanaryAdapter(lease, run, connectionsFor(), core, { pause, qualificationProfile: "smoke" });
    const error = await adapter.qualify(image, "claude-setup-token").catch(value => value);
    expect(error).toBeInstanceOf(PromotionError);
    expect(error.message).toContain(reason === "forbidden" ? "file.write" : "unconfirmed");
    expect(error.message).not.toContain("synthetic-private-start-diagnostic");
    expect(core.poll).not.toHaveBeenCalled(); expect(pause).not.toHaveBeenCalled();
    expect(run.canaries[0]).toMatchObject({ phase: "starting" });
    expect(run.canaries[0].outcome).toBeUndefined(); expect(run.canaries[0].retired).not.toBe(true);
    expect(core.start).toHaveBeenCalledOnce();
  });
  it("persists a definite prelaunch rejection separately from outcome and refuses polling on resume", async () => {
    const lease = leaseFor(), run: any = runFor();
    const core = { allocate: vi.fn(async () => {}), ready: vi.fn(async () => true),
      start: vi.fn(async () => { throw new ReleaseCanaryPrelaunchError(); }),
      poll: vi.fn(async () => ({ running: true })), retire: vi.fn(async () => {}) };
    const options = { qualificationProfile: "smoke" as const, pause: vi.fn(async () => {}) };
    await expect(releaseCanaryAdapter(lease, run, connectionsFor(), core, options).qualify(image, "claude-setup-token")).rejects.toThrow("file.write");
    expect(run.canaries[0].prelaunchFailure).toEqual({ version: 1, stage: "private-input-upload", classification: "forbidden", status: 403 });
    expect(run.canaries[0].outcome).toBeUndefined();
    await expect(releaseCanaryAdapter(lease, run, connectionsFor(), core, options).qualify(image, "claude-setup-token")).rejects.toThrow("file.write");
    expect(core.poll).not.toHaveBeenCalled(); expect(core.start).toHaveBeenCalledOnce();
  });
  it("attests the disposable clone before server dispatch, retains fixed evidence and physically deletes it", async () => {
    const lease = leaseFor(), run: any = runFor(), calls: string[] = [];
    const core = { allocate: vi.fn(async () => { calls.push("allocate"); }), ready: vi.fn(async () => { calls.push("attest"); return true; }),
      start: vi.fn(async (_job: any, input: any) => { calls.push("server-dispatch"); expect(input).not.toHaveProperty("material"); expect(input.qualificationProfile).toBe("smoke"); }),
      poll: vi.fn(async () => ({ code: 0, retirement: 0, report: { version: 3, qualified: true, qualificationProfile: "smoke", executionProfile: "zeros-cloud-native-v1",
        authority: "isolated-image-canary", qualifiedAt: new Date().toISOString(), identity: { ...image, contractSha256: "c".repeat(64), kind: "claude-setup-token", model: SMOKE_MODELS.claude }, checks: ["nativeTurn"] } })),
      retire: vi.fn(async () => { calls.push("delete"); }) };
    const adapter = releaseCanaryAdapter(lease, run, connectionsFor(), core, { pause: async () => {}, qualificationProfile: "smoke" });
    const result = await adapter.qualify(image, "claude-setup-token");
    expect(result.connection.kind).toBe("claude-setup-token"); expect(result.outcome.report.qualified).toBe(true);
    expect(calls).toEqual(["allocate", "attest", "server-dispatch", "delete"]);
    expect(JSON.stringify(run)).not.toContain("material");
  });
  it("polls a persisted lost dispatch instead of starting another credential-bearing VM", async () => {
    const lease = leaseFor(), job = { id: randomUUID(), ...workerConnections()[0], qualificationProfile: "full", phase: "starting", startedAt: Date.now(), image }, run: any = { ...runFor(), canaries: [job] };
    const core = { allocate: vi.fn(), ready: vi.fn(), start: vi.fn(), poll: vi.fn(async () => ({ code: 1, retirement: 0, report: { qualified: false, failureKind: "rate-limited" } })), retire: vi.fn() };
    const adapter = releaseCanaryAdapter(lease, run, connectionsFor("full"), core, { pause: async () => {} });
    expect((await adapter.qualify(image, "claude-setup-token")).outcome.report.failureKind).toBe("rate-limited");
    expect(core.start).not.toHaveBeenCalled(); expect(core.allocate).not.toHaveBeenCalled(); expect(core.retire).toHaveBeenCalledOnce();
  });
  it("fails closed before credential admission on stale attestation and refuses profile changes on recovery", async () => {
    const lease = leaseFor(), run: any = runFor(), core = { allocate: vi.fn(), ready: vi.fn(async () => "failed"), start: vi.fn(), retire: vi.fn() };
    const adapter = releaseCanaryAdapter(lease, run, connectionsFor(), core, { qualificationProfile: "smoke" });
    await expect(adapter.qualify(image, "claude-setup-token")).rejects.toThrow("attestation"); expect(core.start).not.toHaveBeenCalled();
    const full = releaseCanaryAdapter(lease, run, connectionsFor("full"), core, { qualificationProfile: "full" });
    await expect(full.qualify(image, "claude-setup-token")).rejects.toThrow("profile or model changed");
  });
  it("never reports cleanup success when physical deletion is uncertain", async () => {
    const run: any = { canaries: [{ id: randomUUID(), kind: "cursor-api-key" }] }, core = { retire: vi.fn(async () => { throw new Error("synthetic-private"); }) };
    expect(await releaseCanaryAdapter(leaseFor(), run, new Map(), core).cleanup()).toBe(false);
    expect(run.canaries[0].retired).not.toBe(true);
  });
});
