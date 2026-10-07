import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Hono } from "hono";
import pg from "pg";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { HttpError } from "../authz.js";
import type { Config } from "../config.js";
import { withSystemTx, withUserTx } from "../db.js";
import { resetMigratedTestDatabase } from "../test-database.js";
import {
  runtimeArtifactObjectKey,
  type RuntimeArtifactStore,
} from "./runtime-artifact-store.js";
import {
  createRuntimePublicationRoutes,
  createRuntimeStaffRoutes,
  DatabaseRuntimePublicationService,
  readRuntimeReleaseIdentity,
  readRuntimeStatus,
  RUNTIME_BASE_REGISTRATION_PATH,
  RUNTIME_PUBLICATION_PATH,
  RUNTIME_STAFF_PATH,
} from "./runtime-publication-routes.js";
import type { RuntimePublicationProvenance } from "./runtime-oidc.js";
import { selectCloudRuntime } from "./runtime-selection.js";

const fixtures = new URL(
  "../../../../packages/protocol/src/__tests__/fixtures/cloud-runtime/",
  import.meta.url,
);
const rawManifest = readFileSync(new URL("manifest.valid.json", fixtures));
const { files: _files, ...manifestHeader } = JSON.parse(
  rawManifest.toString("utf8"),
);
const manifestSha256 = createHash("sha256").update(rawManifest).digest("hex");
const descriptor = {
  runtimeId: `r1-${manifestSha256}`,
  manifestSha256,
  archiveSha256: "b".repeat(64),
  archiveBytes: 123,
  expandedBytes: 456,
  sourceCommit: manifestHeader.source.commit,
  nodeModulesAbi: manifestHeader.platform.nodeModulesAbi,
  bootstrapProtocolVersion: 1,
  engineProtocolVersion: manifestHeader.protocols.engine,
};
const body = {
  descriptor,
  manifestHeader,
  releaseOrder: 1234,
  githubRunId: 1234,
  githubRunAttempt: 1,
};
const provenance: RuntimePublicationProvenance = {
  runId: body.githubRunId,
  runNumber: 42,
  runAttempt: body.githubRunAttempt,
  sha: descriptor.sourceCommit,
  workflowRef:
    "Withso/zeros/.github/workflows/release-alpha.yml@refs/heads/main",
};
const rawCompatibility = readFileSync(
  new URL("base-compatibility.valid.json", fixtures),
);
const compatibility = JSON.parse(rawCompatibility.toString("utf8"));
const compatibilitySha256 = createHash("sha256")
  .update(rawCompatibility)
  .digest("hex");
const baseCompatibilityId = `bc1-${compatibilitySha256}`;
const baseBody = {
  baseImageId: "zeros-v2-test-base",
  imageRef: `boat:zeros-v2-test-base@sha256:${"c".repeat(64)}`,
  sourceCommit: descriptor.sourceCommit,
  imageBuildSha256: "c".repeat(64),
  storageMib: 20480,
  compatibilityRawB64: rawCompatibility.toString("base64"),
  compatibilitySha256,
};
const config = {
  deploymentChannel: "alpha",
  cloudRuntimePublication: {
    enabled: true,
    audience: "zeros-control-plane-alpha",
    repository: "Withso/zeros",
    environment: "alpha",
    s3: null,
  },
} as Config;
const objectKey = runtimeArtifactObjectKey(
  descriptor.runtimeId,
  descriptor.archiveSha256,
);
const databaseUrl = process.env.TEST_DATABASE_URL;

(databaseUrl ? describe : describe.skip)(
  "stateless runtime publication registry",
  () => {
    let pool: pg.Pool;
    let service: DatabaseRuntimePublicationService;
    let objects: Map<string, number>;
    let artifacts: RuntimeArtifactStore;
    const enqueueSmoke = vi.fn(async (_id: string) => "not_configured");
    beforeAll(() => {
      pool = new pg.Pool({ connectionString: databaseUrl, max: 8 });
    });
    afterAll(async () => {
      await pool.end();
    });
    beforeEach(async () => {
      await resetMigratedTestDatabase(pool);
      objects = new Map();
      artifacts = {
        head: vi.fn(async (key) => ({
          exists: objects.has(key),
          bytes: objects.get(key) ?? null,
        })),
        presignCreatePut: vi.fn(async (_key, bytes) => ({
          url: "https://objects.example.test/upload",
          expiresAt: new Date(Date.now() + 900_000).toISOString(),
          headers: { "If-None-Match": "*", "Content-Length": String(bytes) },
        })),
        presignGet: vi.fn(async () => ({
          url: "https://objects.example.test/download",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        })),
      };
      enqueueSmoke.mockClear();
      service = new DatabaseRuntimePublicationService(
        pool,
        artifacts,
        enqueueSmoke,
      );
    });
    async function registeredRows() {
      return {
        bundles: (await pool.query("SELECT * FROM cloud_runtime_bundles")).rows,
        releases: (
          await pool.query("SELECT * FROM cloud_runtime_channel_releases")
        ).rows,
      };
    }
    async function complete() {
      objects.set(objectKey, descriptor.archiveBytes);
      return service.complete(body, provenance);
    }
    async function qualify() {
      await service.registerBase(baseBody, provenance);
      await withSystemTx(pool, async (tx) => {
        for (const kind of [
          "claude-setup-token",
          "codex-chatgpt",
          "cursor-api-key",
        ]) {
          await tx.query(
            `INSERT INTO cloud_runtime_qualifications(runtime_id,base_compatibility_id,credential_kind,profile,enabled,mcp_qualified,evidence,qualified_at)
          VALUES($1,$2,$3,'zeros-cloud-worker-v4',true,true,'{"mode":"smoke","checks":["engine_boot"]}'::jsonb,now())`,
            [descriptor.runtimeId, baseCompatibilityId, kind],
          );
        }
      });
    }

    it("authorizes an exact create-only upload without inserting any registry row", async () => {
      const first = await service.publication(body, provenance);
      expect(first.objectKey).toBe(objectKey);
      expect(first.upload?.headers).toEqual({
        "If-None-Match": "*",
        "Content-Length": String(descriptor.archiveBytes),
      });
      expect(await registeredRows()).toEqual({ bundles: [], releases: [] });
      await service.publication(body, provenance);
      objects.set(objectKey, descriptor.archiveBytes);
      expect(await service.publication(body, provenance)).toEqual({
        objectKey,
        upload: null,
      });
      expect(await registeredRows()).toEqual({ bundles: [], releases: [] });
    });

    it("completes from another replica using only the full request and HEAD, then confirms once", async () => {
      await service.publication(body, provenance);
      objects.set(objectKey, descriptor.archiveBytes);
      const anotherReplica = new DatabaseRuntimePublicationService(
        pool,
        artifacts,
        enqueueSmoke,
      );
      expect(await anotherReplica.complete(body, provenance)).toEqual({
        runtimeId: descriptor.runtimeId,
        registered: true,
      });
      const first = await registeredRows();
      expect(first.bundles).toHaveLength(1);
      expect(first.releases).toHaveLength(1);
      expect(first.releases[0].confirmed_at).toBeInstanceOf(Date);
      await anotherReplica.complete(body, provenance);
      expect(await registeredRows()).toEqual(first);
      expect(JSON.stringify(first).includes("objects.example.test")).toBe(
        false,
      );
      expect(enqueueSmoke).toHaveBeenCalledWith(descriptor.runtimeId);
      expect(
        (await pool.query("SELECT * FROM cloud_runtime_qualifications")).rows,
      ).toHaveLength(0);
    });

    it("allows completion without a prior publication call", async () => {
      expect(await complete()).toEqual({
        runtimeId: descriptor.runtimeId,
        registered: true,
      });
      expect(artifacts.presignCreatePut).not.toHaveBeenCalled();
    });

    it.each([undefined, 0, 122, 124])(
      "requires an existing object of exactly the advertised size (%s)",
      async (bytes) => {
        if (bytes !== undefined) objects.set(objectKey, bytes);
        await expect(service.complete(body, provenance)).rejects.toMatchObject({
          status: 409,
          code:
            bytes === undefined
              ? "runtime_artifact_missing"
              : "runtime_artifact_size_conflict",
        });
        expect(await registeredRows()).toEqual({ bundles: [], releases: [] });
        expect(enqueueSmoke).not.toHaveBeenCalled();
      },
    );

    it("never returns an existing short object as a successful upload authorization", async () => {
      objects.set(objectKey, 122);
      await expect(service.publication(body, provenance)).rejects.toMatchObject(
        { status: 409, code: "runtime_artifact_size_conflict" },
      );
      expect(artifacts.presignCreatePut).not.toHaveBeenCalled();
    });

    it("coalesces concurrent exact completion writes through immutable equality", async () => {
      objects.set(objectKey, descriptor.archiveBytes);
      const results = await Promise.all(
        Array.from({ length: 8 }, () => service.complete(body, provenance)),
      );
      expect(results.every((result) => result.registered)).toBe(true);
      expect((await registeredRows()).bundles).toHaveLength(1);
      expect((await registeredRows()).releases).toHaveLength(1);
    });

    it("rejects changes to a registered descriptor or manifest header without altering identity", async () => {
      await complete();
      const before = await registeredRows();
      for (const changed of [
        { ...body, descriptor: { ...descriptor, expandedBytes: 457 } },
        {
          ...body,
          manifestHeader: {
            ...manifestHeader,
            agents: { ...manifestHeader.agents, codex: { package: "0.160.1" } },
          },
        },
        {
          ...body,
          descriptor: { ...descriptor, archiveSha256: "d".repeat(64) },
        },
      ]) {
        objects.set(
          runtimeArtifactObjectKey(
            changed.descriptor.runtimeId,
            changed.descriptor.archiveSha256,
          ),
          descriptor.archiveBytes,
        );
        await expect(
          service.publication(changed, provenance),
        ).rejects.toMatchObject({
          status: 409,
          code: "runtime_identity_conflict",
        });
        await expect(
          service.complete(changed, provenance),
        ).rejects.toMatchObject({
          status: 409,
          code: "runtime_identity_conflict",
        });
      }
      expect(await registeredRows()).toEqual(before);
    });

    it("rolls back a new bundle when the release order already belongs to another runtime", async () => {
      await complete();
      const before = await registeredRows();
      const digest = "d".repeat(64);
      const other = {
        ...body,
        descriptor: {
          ...descriptor,
          runtimeId: `r1-${digest}`,
          manifestSha256: digest,
        },
      };
      objects.set(
        runtimeArtifactObjectKey(
          other.descriptor.runtimeId,
          other.descriptor.archiveSha256,
        ),
        descriptor.archiveBytes,
      );
      await expect(service.complete(other, provenance)).rejects.toMatchObject({
        status: 409,
        code: "runtime_identity_conflict",
      });
      expect(await registeredRows()).toEqual(before);
    });

    it("allows an identical later verified attempt while preserving the first registration provenance", async () => {
      await complete();
      const before = await registeredRows();
      const rerunBody = { ...body, githubRunAttempt: 2 };
      const rerunProvenance = { ...provenance, runAttempt: 2 };
      expect(await service.publication(rerunBody, rerunProvenance)).toEqual({
        objectKey,
        upload: null,
      });
      expect(await service.complete(rerunBody, rerunProvenance)).toEqual({
        runtimeId: descriptor.runtimeId,
        registered: true,
      });
      expect(await registeredRows()).toEqual(before);
      expect(before.releases[0].github_release_run_attempt).toBe(1);
      expect(enqueueSmoke).toHaveBeenCalledTimes(2);
      expect(enqueueSmoke).toHaveBeenLastCalledWith(descriptor.runtimeId);
    });

    it("rejects a verified attempt older than the first registered attempt", async () => {
      objects.set(objectKey, descriptor.archiveBytes);
      await service.complete(
        { ...body, githubRunAttempt: 2 },
        { ...provenance, runAttempt: 2 },
      );
      const before = await registeredRows();
      await expect(service.publication(body, provenance)).rejects.toMatchObject(
        {
          status: 409,
          code: "runtime_identity_conflict",
        },
      );
      await expect(service.complete(body, provenance)).rejects.toMatchObject({
        status: 409,
        code: "runtime_identity_conflict",
      });
      expect(await registeredRows()).toEqual(before);
      expect(enqueueSmoke).toHaveBeenCalledOnce();
    });

    it("rejects a conflicting verified run or order rather than rewriting a confirmed release", async () => {
      await complete();
      const before = await registeredRows();
      await expect(
        service.complete(
          { ...body, githubRunId: 1235 },
          { ...provenance, runId: 1235 },
        ),
      ).rejects.toMatchObject({ status: 409 });
      await expect(
        service.complete(
          { ...body, releaseOrder: 43 },
          provenance,
        ),
      ).rejects.toMatchObject({ status: 409 });
      expect(await registeredRows()).toEqual(before);
    });

    it("reuses a bundle for a later independently verified release with the same source", async () => {
      await complete();
      await service.complete(
        { ...body, releaseOrder: 1235, githubRunId: 1235 },
        { ...provenance, runNumber: 43, runId: 1235 },
      );
      const rows = await registeredRows();
      expect(rows.bundles).toHaveLength(1);
      expect(rows.releases).toHaveLength(2);
    });

    it("commits before scheduling smoke and supports safe scheduling retries", async () => {
      objects.set(objectKey, descriptor.archiveBytes);
      const enqueue = vi.fn(async () => {
        expect(
          (await registeredRows()).releases[0].confirmed_at,
        ).toBeInstanceOf(Date);
        throw new Error(
          "https://private.example.test/smoke?token=private-sentinel",
        );
      });
      const failing = new DatabaseRuntimePublicationService(
        pool,
        artifacts,
        enqueue,
      );
      await expect(failing.complete(body, provenance)).rejects.toMatchObject({
        status: 503,
        code: "runtime_smoke_scheduling_failed",
      });
      const before = await registeredRows();
      await service.complete(body, provenance);
      expect(await registeredRows()).toEqual(before);
    });

    it("recovers a post-commit smoke enqueue failure on a later verified attempt", async () => {
      objects.set(objectKey, descriptor.archiveBytes);
      const enqueue = vi.fn(async (_id: string) => "not_configured");
      enqueue.mockRejectedValueOnce(new Error("temporary enqueue failure"));
      const retrying = new DatabaseRuntimePublicationService(
        pool,
        artifacts,
        enqueue,
      );
      await expect(retrying.complete(body, provenance)).rejects.toMatchObject({
        status: 503,
        code: "runtime_smoke_scheduling_failed",
      });
      const before = await registeredRows();
      expect(before.releases[0].confirmed_at).toBeInstanceOf(Date);
      const rerunBody = { ...body, githubRunAttempt: 2 };
      const rerunProvenance = { ...provenance, runAttempt: 2 };
      expect(await retrying.publication(rerunBody, rerunProvenance)).toEqual({
        objectKey,
        upload: null,
      });
      expect(await retrying.complete(rerunBody, rerunProvenance)).toEqual({
        runtimeId: descriptor.runtimeId,
        registered: true,
      });
      expect(await registeredRows()).toEqual(before);
      expect(before.releases[0].github_release_run_attempt).toBe(1);
      expect(enqueue).toHaveBeenCalledTimes(2);
      expect(enqueue).toHaveBeenLastCalledWith(descriptor.runtimeId);
    });

    it("closes storage errors without exposing URLs or inserting registry rows", async () => {
      vi.mocked(artifacts.head).mockRejectedValue(
        new Error(
          "https://private.example.test/archive?token=private-sentinel",
        ),
      );
      await expect(service.complete(body, provenance)).rejects.toMatchObject({
        status: 503,
        message: "Runtime artifact unavailable",
      });
      expect(await registeredRows()).toEqual({ bundles: [], releases: [] });
      vi.mocked(artifacts.head).mockResolvedValue({ exists: false, bytes: 0 });
      vi.mocked(artifacts.presignCreatePut).mockRejectedValue(
        new Error("https://private.example.test/upload?token=private-sentinel"),
      );
      await expect(service.publication(body, provenance)).rejects.toMatchObject(
        { status: 503, message: "Runtime artifact unavailable" },
      );
    });

    it("registers/approves a raw-byte base identity idempotently and atomically", async () => {
      expect(
        await service.registerBase({ ...baseBody, compatibility }, provenance),
      ).toEqual({ baseImageId: baseBody.baseImageId, baseCompatibilityId });
      const before = (
        await pool.query("SELECT * FROM cloud_runtime_base_images")
      ).rows;
      await service.registerBase(baseBody, provenance);
      expect(
        (await pool.query("SELECT * FROM cloud_runtime_base_images")).rows,
      ).toEqual(before);
      expect(
        (
          await pool.query(
            "SELECT contract_sha256,contract FROM cloud_runtime_base_contracts",
          )
        ).rows,
      ).toEqual([
        { contract_sha256: compatibilitySha256, contract: compatibility },
      ]);
      expect(before[0].approved_at).toBeInstanceOf(Date);
    });

    it("hashes raw compatibility bytes, including insignificant JSON whitespace", async () => {
      const raw = Buffer.from(JSON.stringify(compatibility, null, 2) + "\n");
      const sha256 = createHash("sha256").update(raw).digest("hex");
      const result = await service.registerBase(
        {
          ...baseBody,
          compatibilityRawB64: raw.toString("base64"),
          compatibilitySha256: sha256,
        },
        provenance,
      );
      expect(result.baseCompatibilityId).toBe(`bc1-${sha256}`);
      expect(result.baseCompatibilityId === baseCompatibilityId).toBe(false);
    });

    it("rolls back a conflicting base image and any new contract", async () => {
      await service.registerBase(baseBody, provenance);
      const raw = Buffer.from(
        JSON.stringify({ ...compatibility, glibc: "2.40" }),
      );
      const conflicting = {
        ...baseBody,
        compatibilityRawB64: raw.toString("base64"),
        compatibilitySha256: createHash("sha256").update(raw).digest("hex"),
      };
      await expect(
        service.registerBase(conflicting, provenance),
      ).rejects.toMatchObject({ status: 409 });
      await expect(
        service.registerBase({ ...baseBody, storageMib: 10240 }, provenance),
      ).rejects.toMatchObject({ status: 409 });
      await expect(
        service.registerBase(
          { ...baseBody, baseImageId: "zeros-v2-test-base-other" },
          provenance,
        ),
      ).rejects.toMatchObject({ status: 409 });
      expect(
        (await pool.query("SELECT * FROM cloud_runtime_base_contracts")).rows,
      ).toHaveLength(1);
      expect(
        (await pool.query("SELECT * FROM cloud_runtime_base_images")).rows,
      ).toHaveLength(1);
    });

    it("keeps revoked base identities revoked and rejects a mismatched digest before writes", async () => {
      await expect(
        service.registerBase(
          { ...baseBody, compatibilitySha256: "d".repeat(64) },
          provenance,
        ),
      ).rejects.toMatchObject({ status: 422 });
      expect(
        (await pool.query("SELECT * FROM cloud_runtime_base_contracts")).rows,
      ).toHaveLength(0);
      await service.registerBase(baseBody, provenance);
      await withSystemTx(pool, (tx) =>
        tx.query(
          "UPDATE cloud_runtime_base_contracts SET revoked_at=now() WHERE base_compatibility_id=$1",
          [baseCompatibilityId],
        ),
      );
      await expect(
        service.registerBase(baseBody, provenance),
      ).rejects.toMatchObject({ status: 409 });
    });

    it("keeps registry reads private to system context after endpoint registration", async () => {
      await complete();
      await qualify();
      await withUserTx(pool, randomUUID(), async (tx) => {
        for (const table of [
          "cloud_runtime_bundles",
          "cloud_runtime_channel_releases",
          "cloud_runtime_base_contracts",
          "cloud_runtime_base_images",
          "cloud_runtime_qualifications",
        ]) {
          expect((await tx.query(`SELECT * FROM ${table}`)).rows).toHaveLength(
            0,
          );
        }
      });
    });

    it("lists bases, the last twenty runtimes, their qualifications and releases without claiming a head", async () => {
      await complete();
      await qualify();
      for (let index = 0; index < 20; index++) {
        const digest = createHash("sha256")
          .update(`zeros-v2-test-runtime-${index}`)
          .digest("hex");
        const next = {
          ...body,
          descriptor: {
            ...descriptor,
            runtimeId: `r1-${digest}`,
            manifestSha256: digest,
          },
          releaseOrder: 1235 + index,
          githubRunId: 1235 + index,
        };
        objects.set(
          runtimeArtifactObjectKey(
            next.descriptor.runtimeId,
            next.descriptor.archiveSha256,
          ),
          descriptor.archiveBytes,
        );
        await service.complete(next, {
          ...provenance,
          runNumber: 43 + index,
          runId: next.githubRunId,
        });
      }
      const status = await readRuntimeStatus(pool, "alpha");
      expect(status.bases).toHaveLength(1);
      expect(status.runtimes).toHaveLength(20);
      expect(status.channelReleases).toHaveLength(20);
      expect(status).not.toHaveProperty("channelHead");
      expect(
        status.qualifications.every((row) =>
          status.runtimes.some(
            (runtime) => runtime.runtimeId === row.runtimeId,
          ),
        ),
      ).toBe(true);
      expect(status.channelReleases[0].releaseOrder).toBe(1254);
    });

    it("revokes the bundle and all qualifications, preserves timestamps on retries and logs a closed audit line", async () => {
      await complete();
      await qualify();
      const app = new Hono();
      app.use("*", async (c, next) => {
        c.set("user", { staffRole: "developer" });
        await next();
      });
      app.route("/", createRuntimeStaffRoutes(config, pool));
      app.onError((error, c) =>
        c.json(
          { error: { code: (error as HttpError).code } },
          (error as HttpError).status,
        ),
      );
      const log = vi.spyOn(console, "info").mockImplementation(() => {});
      try {
        expect((await app.request(`${RUNTIME_STAFF_PATH}/status`)).status).toBe(
          200,
        );
        const path = `${RUNTIME_STAFF_PATH}/runtimes/${descriptor.runtimeId}/revoke`;
        const response = await app.request(path, { method: "POST" });
        expect(response.status).toBe(200);
        expect(response.headers.get("Cache-Control")).toBe("no-store");
        const first = await readRuntimeStatus(pool, "alpha");
        expect(first.runtimes[0].revokedAt).toBeInstanceOf(Date);
        expect(first.qualifications).toHaveLength(3);
        expect(
          first.qualifications.every(
            (row) =>
              !row.enabled &&
              !row.mcpQualified &&
              row.revokedAt instanceof Date,
          ),
        ).toBe(true);
        await app.request(path, { method: "POST" });
        expect(await readRuntimeStatus(pool, "alpha")).toEqual(first);
        expect(log).toHaveBeenCalledWith("[cloud-runtime] runtime_revoked", {
          runtimeId: descriptor.runtimeId,
          staffRole: "developer",
        });
        await expect(service.complete(body, provenance)).rejects.toMatchObject({
          status: 409,
        });
        const missing = await app.request(
          `${RUNTIME_STAFF_PATH}/runtimes/r1-${"d".repeat(64)}/revoke`,
          { method: "POST" },
        );
        expect(missing.status).toBe(404);
      } finally {
        log.mockRestore();
      }
    });

    it("reports independent base/runtime sources and a bounded qualification summary", async () => {
      await complete();
      const baseSource = "c".repeat(40);
      await service.registerBase(
        { ...baseBody, sourceCommit: baseSource },
        { ...provenance, sha: baseSource },
      );
      await withSystemTx(pool, (tx) =>
        tx.query(
          `INSERT INTO cloud_runtime_qualifications(runtime_id,base_compatibility_id,credential_kind,profile,enabled,mcp_qualified,evidence,qualified_at)
      VALUES($1,$2,'codex-chatgpt','zeros-cloud-worker-v4',true,true,'{"mode":"smoke"}',now())`,
          [descriptor.runtimeId, baseCompatibilityId],
        ),
      );
      expect(await readRuntimeReleaseIdentity(pool, "v4")).toEqual({
        newWorkspaceProfile: "v4",
        newestApprovedBase: {
          baseImageId: baseBody.baseImageId,
          baseCompatibilityId,
          sourceCommit: baseSource,
        },
        newestRegisteredRuntime: {
          runtimeId: descriptor.runtimeId,
          sourceCommit: descriptor.sourceCommit,
          revoked: false,
        },
        qualificationSummary: {
          enabledKinds: 1,
          mcpQualifiedKinds: 1,
          smokeKinds: 1,
        },
      });
    });

    it("serves the three exact stateless publication endpoints with verified provenance", async () => {
      const app = createRuntimePublicationRoutes(config, pool, {
        artifacts,
        verifyOidc: async () => provenance,
        enqueueSmoke,
      });
      app.onError((error, c) =>
        c.json(
          { error: { code: (error as HttpError).code } },
          (error as HttpError).status,
        ),
      );
      const post = (path: string, payload: unknown) =>
        app.request(path, {
          method: "POST",
          headers: {
            Authorization: "Bearer synthetic-oidc-token",
            "Content-Type": "application/json",
          },
          body: JSON.stringify(payload),
        });
      expect((await post(RUNTIME_PUBLICATION_PATH, body)).status).toBe(200);
      objects.set(objectKey, descriptor.archiveBytes);
      const response = await post(`${RUNTIME_PUBLICATION_PATH}/complete`, body);
      expect(response.status).toBe(200);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(await response.json()).toEqual({
        runtimeId: descriptor.runtimeId,
        registered: true,
      });
      expect(
        (await post(RUNTIME_BASE_REGISTRATION_PATH, baseBody)).status,
      ).toBe(200);
    });

    it.each(["alpha", "beta", "production"] as const)(
      "publishes standalone bundles only into its configured %s channel and preserves replay",
      async channel => {
        const verifyOidc = vi.fn(async () => ({ ...provenance,
          workflowRef: "Withso/zeros/.github/workflows/cloud-runtime-bundle.yml@refs/heads/main" }));
        const app = createRuntimePublicationRoutes({ ...config, deploymentChannel: channel,
          cloudRuntimePublication: { ...config.cloudRuntimePublication!, environment: channel } }, pool, { artifacts, verifyOidc, enqueueSmoke });
        app.onError((error, c) => c.json({ error: { code: (error as HttpError).code } }, (error as HttpError).status));
        const post = (path: string, payload: unknown) => app.request(path, { method: "POST",
          headers: { Authorization: "Bearer synthetic-oidc-token", "Content-Type": "application/json" }, body: JSON.stringify(payload) });
        expect((await post(RUNTIME_PUBLICATION_PATH, body)).status).toBe(200);
        expect((await post(RUNTIME_PUBLICATION_PATH, { ...body, channel: "foreign" })).status).toBe(422);
        objects.set(objectKey, descriptor.archiveBytes);
        expect((await post(`${RUNTIME_PUBLICATION_PATH}/complete`, body)).status).toBe(200);
        const first = await registeredRows();
        expect(first.releases).toHaveLength(1);
        expect(first.releases[0]).toMatchObject({ channel, github_release_run_id: String(provenance.runId) });
        expect((await post(`${RUNTIME_PUBLICATION_PATH}/complete`, body)).status).toBe(200);
        expect(await registeredRows()).toEqual(first);
        expect((await pool.query("SELECT * FROM cloud_runtime_qualifications")).rows).toHaveLength(0);
        if (channel !== "alpha") {
          verifyOidc.mockClear();
          expect((await post(RUNTIME_BASE_REGISTRATION_PATH, baseBody)).status).toBe(404);
          expect(verifyOidc).not.toHaveBeenCalled();
          expect((await pool.query("SELECT * FROM cloud_runtime_base_images")).rows).toHaveLength(0);
        }
      },
    );

    it("isolates conflicting workflow counters across configured publication channels", async () => {
      objects.set(objectKey, descriptor.archiveBytes);
      await service.complete(body, provenance);
      for (const [channel, runId] of [["beta", 2234], ["production", 3234]] as const) {
        const other = new DatabaseRuntimePublicationService(pool, artifacts, enqueueSmoke, channel);
        const request = { ...body, releaseOrder: runId, githubRunId: runId };
        const identity = { ...provenance, runId,
          workflowRef: "Withso/zeros/.github/workflows/cloud-runtime-bundle.yml@refs/heads/main" };
        await expect(other.publication(request, identity)).resolves.toMatchObject({ objectKey });
        await expect(other.complete(request, identity)).resolves.toMatchObject({ registered: true });
      }
      const rows = (await registeredRows()).releases;
      expect(rows.map(row => row.channel).sort()).toEqual(["alpha", "beta", "production"]);
      for (const channel of ["alpha", "beta", "production"] as const) {
        const status = await readRuntimeStatus(pool, channel);
        expect(status.channelReleases).toHaveLength(1);
        const release = rows.find(row => row.channel === channel)!;
        expect(status.channelReleases[0]).toMatchObject({
          releaseOrder: Number(release.github_release_run_id),
          githubRunId: Number(release.github_release_run_id),
        });
      }
    });

    it("interleaves standalone and Alpha workflow counters while preserving historical release retries", async () => {
      await complete();
      await withSystemTx(pool, async tx => {
        await tx.query(`INSERT INTO cloud_runtime_channel_releases
          (channel,release_order,runtime_id,github_release_run_id,github_release_run_attempt,confirmed_at)
          VALUES('alpha',42,$1,1001,1,now()) ON CONFLICT DO NOTHING`, [descriptor.runtimeId]);
      });
      const historical = (await registeredRows()).releases.find(row => row.github_release_run_id === "1001");
      await qualify();
      const head = () => withSystemTx(pool, tx => selectCloudRuntime(tx, "smoke"));
      const standalone = { ...body, releaseOrder: 2001, githubRunId: 2001 };
      const standaloneIdentity = { ...provenance, runId: 2001,
        workflowRef: "Withso/zeros/.github/workflows/cloud-runtime-bundle.yml@refs/heads/main" };
      await expect(service.publication(standalone, standaloneIdentity)).resolves.toMatchObject({ objectKey });
      await expect(service.complete(standalone, standaloneIdentity)).resolves.toMatchObject({ registered: true });
      expect((await head())?.releaseOrder).toBe(2001n);
      await service.complete({ ...body, releaseOrder: 2002, githubRunId: 2002 }, { ...provenance, runNumber: 43, runId: 2002 });
      expect((await head())?.releaseOrder).toBe(2002n);
      const rows = (await registeredRows()).releases;
      const standaloneRow = rows.find(row => row.github_release_run_id === "2001");
      const nextAlpha = rows.find(row => row.github_release_run_id === "2002");
      expect(Number(standaloneRow!.release_order)).toBe(2001);
      expect(Number(nextAlpha!.release_order)).toBe(2002);
      expect((await readRuntimeStatus(pool, "alpha")).channelReleases[0].releaseOrder).toBe(2002);
      const legacy = { ...body, releaseOrder: 42, githubRunId: 1001 };
      const legacyIdentity = { ...provenance, runId: 1001 };
      const beforeRetry = await registeredRows();
      await expect(service.publication(legacy, legacyIdentity)).resolves.toMatchObject({ objectKey, upload: null });
      await service.complete(legacy, legacyIdentity);
      // Updated publishers can retry a historical run without assigning it a new order.
      await service.complete({ ...legacy, releaseOrder: 1001 }, legacyIdentity);
      expect(await registeredRows()).toEqual(beforeRetry);
      expect((await head())?.releaseOrder).toBe(2002n);
      expect((await registeredRows()).releases.find(row => row.github_release_run_id === "1001")).toEqual(historical);
    });

    it.each(["alpha", "beta", "production"] as const)(
      "refuses new legacy run-number releases in %s before artifact or registry effects",
      async channel => {
        const publisher = new DatabaseRuntimePublicationService(pool, artifacts, enqueueSmoke, channel);
        const legacy = { ...body, releaseOrder: provenance.runNumber };
        const identity = { ...provenance,
          workflowRef: channel === "alpha" ? provenance.workflowRef :
            "Withso/zeros/.github/workflows/cloud-runtime-bundle.yml@refs/heads/main" };
        for (const operation of ["publication", "complete"] as const) {
          await expect(publisher[operation](legacy, identity)).rejects.toMatchObject({
            status: 409, code: "runtime_identity_conflict",
          });
        }
        expect(artifacts.head).not.toHaveBeenCalled();
        expect(artifacts.presignCreatePut).not.toHaveBeenCalled();
        expect(enqueueSmoke).not.toHaveBeenCalled();
        expect(await registeredRows()).toEqual({ bundles: [], releases: [] });
      },
    );

    it("requires a legacy retry to retain its existing channel and runtime", async () => {
      await complete();
      await withSystemTx(pool, tx => tx.query(`INSERT INTO cloud_runtime_channel_releases
        (channel,release_order,runtime_id,github_release_run_id,github_release_run_attempt,confirmed_at)
        VALUES('alpha',42,$1,1001,1,now())`, [descriptor.runtimeId]));
      const legacy = { ...body, releaseOrder: 42, githubRunId: 1001 };
      const identity = { ...provenance, runId: 1001 };
      const before = await registeredRows();
      const beta = new DatabaseRuntimePublicationService(pool, artifacts, enqueueSmoke, "beta");
      await expect(beta.complete(legacy, identity)).rejects.toMatchObject({ status: 409, code: "runtime_identity_conflict" });
      const digest = "d".repeat(64);
      await expect(service.complete({ ...legacy, descriptor: { ...descriptor,
        runtimeId: `r1-${digest}`, manifestSha256: digest } }, identity)).rejects.toMatchObject({
        status: 409, code: "runtime_identity_conflict",
      });
      expect(await registeredRows()).toEqual(before);
    });
  },
);
