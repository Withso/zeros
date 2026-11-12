import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { Readable } from "node:stream";
import pg from "pg";
import type { S3Client } from "@aws-sdk/client-s3";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CloudV2Computers } from "../computer.js";
import * as storage from "../runtime-source.js";
import { executionFixture, type ExecutionFixture } from "./test-fixture.js";

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
suite("default-active release canary scope", () => {
  const key = generateKeyPairSync("ed25519"), candidate = "e".repeat(64), source = "f".repeat(40);
  const capabilities = { version: 1, sha256: candidate, sourceSha256: "c".repeat(64), commit: source, features: ["acting-user-v1", "sync-context-v1"] };
  let pool: pg.Pool, f: ExecutionFixture;
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 8 }); });
  afterAll(() => pool.end());
  beforeEach(async () => {
    vi.spyOn(storage, "runtimeStorageClient").mockReturnValue({
      send: vi.fn(async command => {
        if (command.constructor.name === "HeadObjectCommand") return { ContentLength: 123 };
        const sha = /\/([a-f0-9]{64})\.json$/.exec(command.input.Key)?.[1];
        if (sha !== candidate && sha !== "b".repeat(64)) throw { $metadata: { httpStatusCode: 404 } };
        return { Body: Readable.from([Buffer.from(JSON.stringify({ ...capabilities, sha256: sha }))]) };
      }), destroy: vi.fn(),
    } as unknown as S3Client);
    f = await executionFixture(pool, { actingUserDefault: true, runtimeCanaryKey: key.publicKey.export({ type: "spki", format: "der" }).toString("base64") });
    const computers = new CloudV2Computers(pool, pool, async (_org, _user, target) => ({ repository: target.repository, repositoryId: "42" }));
    const build = await computers.enqueue(f.organizationId, f.creator.id, { repositories: [{ repository: "example/project", branch: "main", setup: "" }] });
    await computers.claim(); await computers.activate(build.id, "fresh-fixture-snapshot");
    vi.spyOn(f.cp.routes, "remoteHead").mockResolvedValue("a".repeat(40));
  });
  afterEach(async () => { await f?.close(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
  function grant(patch: Record<string, unknown> = {}) {
    const now = Math.floor(Date.now() / 1000);
    const claims = { version: 1, iss: "zeros-runtime-release", aud: "zeros-cloud-runtime-canary", channel: "alpha", jti: randomUUID(),
      iat: now, exp: now + 600, runId: "123", runAttempt: 1, runtimeSha256: candidate, sourceSha: source,
      creatorUserId: f.creator.id, organizationId: f.organizationId, repositoryId: "42", createKey: randomUUID(), ...patch };
    const body = [{ alg: "EdDSA", typ: "zeros-runtime-canary+jwt", kid: "fixture" }, claims]
      .map(value => Buffer.from(JSON.stringify(value)).toString("base64url")).join(".");
    return { claims, token: `${body}.${sign(null, Buffer.from(body), key.privateKey).toString("base64url")}` };
  }
  const create = (signed = grant(), createKey: string = signed.claims.createKey) => f.call("/v1/cloud-v2/workspaces", "POST", {
    organizationId: f.organizationId, repository: "example/project",
  }, f.creator, { "Idempotency-Key": createKey, "X-Zeros-Runtime-Canary": signed.token });
  const receipts = async () => (await pool.query("SELECT count(*)::int n FROM cloud_v2_execution_creations")).rows[0].n;

  it("admits the exact signed candidate as active without a completed release and keeps its pin", async () => {
    const signed = grant(), response = await create(signed); expect(response.status).toBe(201);
    const { workspace } = await response.json();
    expect((await pool.query("SELECT execution_mode FROM cloud_v2_workspaces WHERE id=$1", [workspace.id])).rows[0].execution_mode).toBe("active");
    expect((await pool.query("SELECT runtime_sha256 FROM cloud_v2_execution_creations WHERE workspace_id=$1", [workspace.id])).rows[0].runtime_sha256).toBe(candidate);
    const expected = f.cp.workers.runtimeSha256ForWorkspace!;
    expect(await expected(workspace)).toBe(candidate);
    await pool.query("UPDATE cloud_v2_execution_creations SET clean_at=clock_timestamp(),clean_boot_id=$2 WHERE workspace_id=$1", [workspace.id, randomUUID()]);
    expect(await expected(workspace)).toBe(candidate);
    const replay = await create(signed); expect(replay.status).toBe(201); expect(await receipts()).toBe(1);
  });

  it.each(["runtimeSha256", "sourceSha", "organizationId", "creatorUserId", "repositoryId", "createKey", "expired"])("rejects another %s without a partial active receipt", async field => {
    const wrong = field === "runtimeSha256" ? "d".repeat(64) : field === "sourceSha" ? "d".repeat(40) : field === "repositoryId" ? "99" : randomUUID();
    const signed = grant(field === "expired" ? { iat: 1, exp: 2 } : field === "createKey" ? {} : { [field]: wrong });
    const response = await create(signed, field === "createKey" ? wrong : signed.claims.createKey);
    expect(response.status).toBe(["runtimeSha256", "sourceSha"].includes(field) ? 409 : 403);
    expect(await receipts()).toBe(0);
    expect((await pool.query("SELECT count(*)::int n FROM cloud_v2_runtime_canaries")).rows[0].n).toBe(0);
  });

  it("consumes a grant once across two distinct create keys", async () => {
    const first = grant(); expect((await create(first)).status).toBe(201);
    const second = grant({ jti: first.claims.jti });
    expect((await create(second)).status).toBe(403);
    expect(await receipts()).toBe(1);
  });

  it("refuses ordinary creation without its completed release instead of borrowing canary authority", async () => {
    const response = await f.call("/v1/cloud-v2/workspaces", "POST", { organizationId: f.organizationId, repository: "example/project" });
    expect(response.status).toBe(409); expect((await response.json()).error.code).toBe("worker_update_required"); expect(await receipts()).toBe(0);
  });
});
