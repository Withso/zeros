import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DatabaseReleaseCanaryService } from "../../apps/control-plane/src/cloud-workspaces/release-canaries";
import { sealCloudAgentCredential } from "../../apps/control-plane/src/cloud-workspaces/agent-credential-envelope";
import { startNativeDevCanary } from "../../apps/control-plane/src/cloud-workspaces/dev-native-canary";
import { HttpError } from "../../apps/control-plane/src/authz";
import { workerEnvironment, workerConnections } from "./worker-test-fixtures";
import { workerExecutionConfig } from "./worker-config";
import { releaseCanaryBroker, ReleaseCanaryPrelaunchError } from "./worker-broker";
import { releaseCanaryAdapter } from "./worker-canary";

const privateText = "synthetic-private-native-access-never-logged";
const image = { snapshotId: "worker-test", sourceCommit: "a".repeat(40), buildSha256: "b".repeat(64), architecture: "linux/amd64" as const, storageMiB: 4096 };
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function harness(snapshots: (boolean | undefined)[] = [false], uploadStatus = 200) {
  const env = workerEnvironment(), { config } = workerExecutionConfig(env), connection = workerConnections()[2]!;
  const key = Buffer.alloc(32, 1).toString("base64url"), envelope = sealCloudAgentCredential({ kind: "cursor-api-key", apiKey: privateText },
    { credentialId: connection.credentialId, ownerUserId: env.RUNTIME_QUALIFICATION_ACTOR_USER_ID!, version: 1, keyVersion: 1, kind: "cursor-api-key" }, key);
  const audits: any[] = [], commands: string[] = [], uploads: any[] = [];
  const query = vi.fn(async (sql: string, values: any[] = []): Promise<any> => {
    if (sql.includes("FROM users account")) return { rows: [], rowCount: 1 };
    if (sql.includes("FROM cloud_agent_credential_versions")) return { rows: [{ ...envelope, auth_tag: envelope.authTag, key_version: 1 }], rowCount: 1 };
    if (sql.includes("FROM cloud_agent_credentials")) return { rows: [{ id: connection.credentialId, owner_user_id: env.RUNTIME_QUALIFICATION_ACTOR_USER_ID,
      kind: connection.kind, revision: "1", current_version: 1, revoked_at: null }], rowCount: 1 };
    if (sql.includes("FROM audit_log pending")) return { rows: [], rowCount: 0 };
    if (sql.includes("FROM audit_log") && sql.includes("operationId")) return { rows: audits.slice(-1), rowCount: audits.length ? 1 : 0 };
    if (sql.includes("FROM audit_log")) return { rows: [{ id: connection.designationId, subject: { ...connection, models: [connection.model], enabled: true,
      channel: "alpha", allowanceOwnerUserId: env.RUNTIME_QUALIFICATION_ACTOR_USER_ID } }], rowCount: 1 };
    if (sql.startsWith("INSERT INTO audit_log")) {
      const audit = { id: String(audits.length + 100), action: values[2], subject: JSON.parse(values[3]) }; audits.push(audit);
      return { rows: [{ id: audit.id }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });
  let observations = 0;
  const provider = vi.fn(async (url: any, options: any) => {
    const route = new URL(url).pathname;
    if (options.method === "GET") return new Response(JSON.stringify({ sandbox: { id: "bx_test", team: { id: "test-wallet" },
      snapshots: snapshots[Math.min(observations++, snapshots.length - 1)] } }));
    const body = JSON.parse(options.body);
    if (options.method === "POST" && route.endsWith("/commands")) {
      commands.push(body.command);
      return new Response(JSON.stringify({ exitCode: 0, stdout: body.command.includes("machine-") ? JSON.stringify({ qualified: true }) : "started" }));
    }
    if (options.method === "PUT" && route.endsWith("/files")) {
      uploads.push(body);
      return new Response(JSON.stringify(uploadStatus === 200 ? { size: Buffer.from(body.content, "base64").length }
        : { error: { code: "api_key_action_forbidden", message: privateText } }), { status: uploadStatus });
    }
    throw new Error("Unexpected synthetic native admission request");
  });
  vi.stubGlobal("fetch", provider);
  const admission = { assertCanary: vi.fn(async () => ({ snapshotsOffRequired: true })) };
  const service = new DatabaseReleaseCanaryService({ connect: async () => ({ query, release: vi.fn() }) } as any,
    { ownerUserId: env.RUNTIME_QUALIFICATION_ACTOR_USER_ID!, organizationId: env.WORKER_CANARY_ORGANIZATION_ID!, channel: "alpha",
      repository: config.repository, sourceSha: config.sourceSha,
      tokenSha256: createHash("sha256").update(env.WORKER_CANARY_ADMISSION_TOKEN!).digest("hex"), keys: { keys: { 1: key }, currentKeyVersion: 1 },
      admission: admission as any, boat: { apiKey: "synthetic-boat-authority", apiUrl: "https://boat.example.test", billingOrg: "test-wallet" } });
  const api = vi.fn(async (url: any, options: any) => {
    const body = JSON.parse(options.body);
    if (String(url).endsWith("/preflight")) return new Response(JSON.stringify({ ...body, ready: true, connections: workerConnections() }));
    try { return new Response(JSON.stringify(await service.admit(body, options.headers.authorization))); }
    catch (error) {
      if (!(error instanceof HttpError)) throw error;
      return new Response(JSON.stringify({ error: { code: error.code, message: error.message } }), { status: error.status });
    }
  });
  const broker = releaseCanaryBroker(config, env, "smoke", api as any);
  return { broker, provider, api, audits, commands, uploads, query, admission };
}

describe("private release native startup observation", () => {
  it.each([undefined, true])("requires actual snapshots=false at the fresh server boundary before opening native material (%s)", async snapshots => {
    const test = harness([snapshots]); await test.broker.preflight();
    await expect(test.broker.start({ id: "bx_test", attempt: "11111111-1111-4111-8111-111111111111",
      snapshotId: image.snapshotId, sourceCommit: image.sourceCommit, buildSha256: image.buildSha256 }, "cursor-api-key")).rejects.toThrow("unconfirmed");
    expect(test.query.mock.calls.some(([sql]) => sql.includes("cloud_agent_credential_versions"))).toBe(false);
    expect(test.uploads).toHaveLength(0); expect(test.commands).toHaveLength(0);
    expect(test.audits.map(row => row.action)).toEqual(["cloud.release_canary.reserved", "cloud.release_canary.preparing"]);
  });
  it("rechecks provider policy immediately before private dispatch even after initial preparation passed", async () => {
    const test = harness([false, true]); await test.broker.preflight();
    await expect(test.broker.start({ id: "bx_test", attempt: "11111111-1111-4111-8111-111111111111",
      snapshotId: image.snapshotId, sourceCommit: image.sourceCommit, buildSha256: image.buildSha256 }, "cursor-api-key")).rejects.toThrow("unconfirmed");
    expect(test.uploads).toHaveLength(0);
    expect(test.audits.at(-1).action).toBe("cloud.release_canary.dispatched");
  });
  it("classifies real private-upload 403 promptly without a launch, outcome, secret diagnostic or polling on resume", async () => {
    const test = harness([false], 403), connections = await test.broker.preflight();
    const run: any = { canaries: [] }, lease = { save: vi.fn(async () => {}), fence: vi.fn(async () => {}) };
    const core = { allocate: vi.fn(async () => {}), ready: vi.fn(async () => true), retire: vi.fn(), poll: vi.fn(),
      start: (job: any) => test.broker.start({ id: "bx_test", attempt: job.id, snapshotId: image.snapshotId, sourceCommit: image.sourceCommit,
        buildSha256: image.buildSha256 }, job.kind, async intent => { job.admissionRequest = intent; }) };
    const log = vi.spyOn(console, "log"), errorLog = vi.spyOn(console, "error");
    const adapter = releaseCanaryAdapter(lease, run, connections, core, { qualificationProfile: "smoke", pause: vi.fn() });
    const error = await adapter.qualify(image, "cursor-api-key").catch(value => value);
    expect(error).toBeInstanceOf(ReleaseCanaryPrelaunchError); expect(error.message).toContain("file.write"); expect(error.message).not.toContain(privateText);
    expect(run.canaries[0].prelaunchFailure).toEqual({ version: 1, stage: "private-input-upload", classification: "forbidden", status: 403 });
    expect(run.canaries[0].outcome).toBeUndefined(); expect(run.canaries[0].phase).toBe("starting");
    expect(test.audits.at(-1).action).toBe("cloud.release_canary.dispatched");
    expect(test.uploads).toHaveLength(1); expect(test.commands).toHaveLength(3);
    expect(test.commands.join("\n")).not.toContain("subprocess.Popen"); expect(test.commands.join("\n")).not.toContain(privateText);
    expect(JSON.stringify(run)).not.toContain(privateText); expect(log).not.toHaveBeenCalled(); expect(errorLog).not.toHaveBeenCalled();
    await expect(adapter.qualify(image, "cursor-api-key")).rejects.toThrow("file.write");
    expect(test.uploads).toHaveLength(1); expect(core.poll).not.toHaveBeenCalled();
  });
  it.each([500, 409, 429])("keeps upload status %s uncertain rather than asserting prelaunch rejection", async status => {
    const test = harness([false], status); await test.broker.preflight();
    const error = await test.broker.start({ id: "bx_test", attempt: "11111111-1111-4111-8111-111111111111",
      snapshotId: image.snapshotId, sourceCommit: image.sourceCommit, buildSha256: image.buildSha256 }, "cursor-api-key").catch(value => value);
    expect(error).not.toBeInstanceOf(ReleaseCanaryPrelaunchError); expect(error.message).toContain("unconfirmed"); expect(error.message).not.toContain(privateText);
    expect(test.audits.at(-1).action).toBe("cloud.release_canary.dispatched");
  });
  it("awaits serialization/upload before any runner command and zeros the private input buffer even on rejection", async () => {
    const command = vi.fn(async () => "prepared"); let retained: Buffer | undefined;
    const upload = vi.fn(async (_path: string, contents: Buffer) => {
      retained = contents; expect(JSON.parse(contents.toString())).toEqual({ material: { kind: "cursor-api-key", apiKey: privateText } });
      throw new Error("Synthetic fixed upload refusal");
    });
    await expect(startNativeDevCanary({ command, upload }, { id: "bx_test", attempt: "11111111-1111-4111-8111-111111111111",
      snapshotId: image.snapshotId, sourceCommit: image.sourceCommit, buildSha256: image.buildSha256 },
    { material: { kind: "cursor-api-key", apiKey: privateText } })).rejects.toThrow("Synthetic fixed upload refusal");
    expect(command).toHaveBeenCalledOnce(); expect(upload).toHaveBeenCalledOnce(); expect(retained!.every(byte => byte === 0)).toBe(true);
    expect(command.mock.calls[0]![0]).not.toContain(privateText);
  });
});
