import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Hono } from "hono";
import type pg from "pg";
import { describe, expect, it, vi } from "vitest";
import {
  BaseCompatibilitySchema,
  RuntimeDescriptorSchema,
  RuntimeManifestSchema,
} from "../../../../packages/protocol/src/cloud-runtime-bundle.js";
import { HttpError } from "../authz.js";
import type { Config } from "../config.js";
import { createApp } from "../app.js";
import {
  runtimeArtifactObjectKey,
  type RuntimeArtifactStore,
} from "./runtime-artifact-store.js";
import {
  createRuntimePublicationRoutes,
  createRuntimeStaffRoutes,
  enqueueRuntimeSmokeQualification,
  RUNTIME_BASE_REGISTRATION_PATH,
  RUNTIME_PUBLICATION_PATH,
  RUNTIME_STAFF_PATH,
  RuntimePublicationInputSchema,
} from "./runtime-publication-routes.js";

const fixtures = new URL(
  "../../../../packages/protocol/src/__tests__/fixtures/cloud-runtime/",
  import.meta.url,
);
const fixtureCases = JSON.parse(
  readFileSync(new URL("cases.json", fixtures), "utf8"),
) as { cases: Array<{ contract: string; file: string; valid: boolean }> };
const rawManifest = readFileSync(new URL("manifest.valid.json", fixtures));
const { files: _files, ...manifestHeader } = RuntimeManifestSchema.parse(
  JSON.parse(rawManifest.toString("utf8")),
);
const manifestSha256 = createHash("sha256").update(rawManifest).digest("hex");
const descriptor = RuntimeDescriptorSchema.parse({
  runtimeId: `r1-${manifestSha256}`,
  manifestSha256,
  archiveSha256: "b".repeat(64),
  archiveBytes: 123,
  expandedBytes: 456,
  sourceCommit: manifestHeader.source.commit,
  nodeModulesAbi: manifestHeader.platform.nodeModulesAbi,
  bootstrapProtocolVersion: 1,
  engineProtocolVersion: manifestHeader.protocols.engine,
});
const publicationBody = {
  descriptor,
  manifestHeader,
  releaseOrder: 1234,
  githubRunId: 1234,
  githubRunAttempt: 1,
};
const provenance = {
  runId: 1234,
  runNumber: 42,
  runAttempt: 1,
  sha: descriptor.sourceCommit,
  workflowRef:
    "Withso/zeros/.github/workflows/release-alpha.yml@refs/heads/main",
};
const rawCompatibility = readFileSync(
  new URL("base-compatibility.valid.json", fixtures),
);
const compatibility = BaseCompatibilitySchema.parse(
  JSON.parse(rawCompatibility.toString("utf8")),
);
const baseBody = {
  baseImageId: "zeros-v2-test-base",
  imageRef: `boat:zeros-v2-test-base@sha256:${"c".repeat(64)}`,
  sourceCommit: descriptor.sourceCommit,
  imageBuildSha256: "c".repeat(64),
  storageMib: 20480,
  compatibilityRawB64: rawCompatibility.toString("base64"),
  compatibilitySha256: createHash("sha256")
    .update(rawCompatibility)
    .digest("hex"),
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
  auth: {
    provider: "auth0",
    issuers: ["https://tenant.example.test/"],
    audience: "https://api.example.test",
    jwksUrl: "https://tenant.example.test/.well-known/jwks.json",
  },
  cloudWorkspaces: null,
  workos: null,
  github: null,
  feedback: null,
  inviteLinkBase: "https://app.example.test/invite",
  databaseUrl: "postgres://unused",
  port: 8080,
  isProduction: false,
} as Config;

function harness(overrides: Partial<Config> = {}) {
  const pool = {
    connect: vi.fn(async () => {
      throw new Error("database must not be reached");
    }),
  } as unknown as pg.Pool;
  const artifacts = {
    head: vi.fn(),
    presignCreatePut: vi.fn(),
    presignGet: vi.fn(),
  } as unknown as RuntimeArtifactStore;
  const verifyOidc = vi.fn(async () => provenance);
  const app = createRuntimePublicationRoutes(
    { ...config, ...overrides },
    pool,
    { artifacts, verifyOidc },
  );
  app.onError((error, c) =>
    c.json(
      { error: { code: error instanceof HttpError ? error.code : "internal" } },
      error instanceof HttpError ? error.status : 500,
    ),
  );
  return { app, pool, artifacts, verifyOidc };
}
const post = (
  app: Hono,
  path: string,
  body: unknown,
  token = "synthetic-oidc-token",
) =>
  app.request(path, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

describe("runtime publication HTTP boundaries", () => {
  it.each(
    fixtureCases.cases.filter((entry) => entry.contract === "descriptor"),
  )("matches the shared descriptor fixture $file", ({ file, valid }) => {
    const candidate = JSON.parse(readFileSync(new URL(file, fixtures), "utf8"));
    expect(
      RuntimePublicationInputSchema.safeParse({
        ...publicationBody,
        descriptor: candidate,
      }).success,
    ).toBe(valid);
  });

  it.each(
    fixtureCases.cases.filter(
      (entry) => entry.contract === "manifest" && entry.valid,
    ),
  )("accepts the shared manifest header from $file", ({ file }) => {
    const { files: _inventory, ...header } = JSON.parse(
      readFileSync(new URL(file, fixtures), "utf8"),
    );
    expect(
      RuntimePublicationInputSchema.safeParse({
        ...publicationBody,
        manifestHeader: header,
      }).success,
    ).toBe(true);
  });

  it.each([
    "manifest.invalid-agent-version-build.json",
    "manifest.invalid-agent-version-long.json",
    "manifest.invalid-agent-version-line-break.json",
    "manifest.invalid-node-abi-too-large.json",
  ])("rejects the shared invalid manifest header from %s", (file) => {
    const { files: _inventory, ...header } = JSON.parse(
      readFileSync(new URL(file, fixtures), "utf8"),
    );
    expect(
      RuntimePublicationInputSchema.safeParse({
        ...publicationBody,
        manifestHeader: header,
      }).success,
    ).toBe(false);
  });

  it.each(["bin/node\rprivate", "bin/node\nprivate", "é".repeat(2049)])(
    "rejects entrypoint paths outside the shared encoding and byte bounds",
    (node) => {
      expect(
        RuntimePublicationInputSchema.safeParse({
          ...publicationBody,
          manifestHeader: {
            ...manifestHeader,
            entrypoints: { ...manifestHeader.entrypoints, node },
          },
        }).success,
      ).toBe(false);
    },
  );

  it("accepts the B1 descriptor and header golden shapes and rejects extra fields", () => {
    expect(
      RuntimePublicationInputSchema.safeParse(publicationBody).success,
    ).toBe(true);
    for (const body of [
      { ...publicationBody, objectKey: "workspace/v2/private" },
      {
        ...publicationBody,
        descriptor: { ...descriptor, runtimeId: `r1-${"d".repeat(64)}` },
      },
      { ...publicationBody, manifestHeader: { ...manifestHeader, files: [] } },
      { ...publicationBody, descriptor: { ...descriptor, archiveBytes: 1.5 } },
    ]) {
      expect(RuntimePublicationInputSchema.safeParse(body).success).toBe(false);
    }
    expect(
      runtimeArtifactObjectKey(
        descriptor.runtimeId,
        descriptor.archiveSha256,
      ).startsWith("runtime/v1/"),
    ).toBe(true);
  });

  it("returns 404 for all publication endpoints while disabled, before auth/body/database work", async () => {
    const { app, pool, verifyOidc } = harness({
      cloudRuntimePublication: {
        ...config.cloudRuntimePublication!,
        enabled: false,
      },
    });
    for (const path of [
      RUNTIME_PUBLICATION_PATH,
      `${RUNTIME_PUBLICATION_PATH}/complete`,
      RUNTIME_BASE_REGISTRATION_PATH,
    ]) {
      const response = await post(app, path, { private: "untrusted" });
      expect(response.status).toBe(404);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
    }
    expect(verifyOidc).not.toHaveBeenCalled();
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it("requires GitHub OIDC even though the route is outside account auth", async () => {
    const { app, pool, verifyOidc } = harness();
    const missing = await app.request(RUNTIME_PUBLICATION_PATH, {
      method: "POST",
    });
    expect(missing.status).toBe(401);
    verifyOidc.mockRejectedValueOnce(
      new Error("https://private.example.test?token=private-sentinel"),
    );
    const rejected = await post(app, RUNTIME_PUBLICATION_PATH, publicationBody);
    expect(rejected.status).toBe(401);
    expect((await rejected.text()).includes("private")).toBe(false);
    expect(rejected.headers.get("Cache-Control")).toBe("no-store");
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it("rejects body provenance that disagrees with verified claims", async () => {
    const { app, pool } = harness();
    for (const changed of [
      { releaseOrder: 43 },
      { githubRunId: 1235 },
      { githubRunAttempt: 2 },
      { descriptor: { ...descriptor, sourceCommit: "c".repeat(40) } },
      {
        manifestHeader: {
          ...manifestHeader,
          platform: { ...manifestHeader.platform, nodeModulesAbi: 128 },
        },
      },
      {
        manifestHeader: {
          ...manifestHeader,
          protocols: { ...manifestHeader.protocols, engine: 21 },
        },
      },
    ]) {
      for (const path of [
        RUNTIME_PUBLICATION_PATH,
        `${RUNTIME_PUBLICATION_PATH}/complete`,
      ]) {
        expect(
          (await post(app, path, { ...publicationBody, ...changed })).status,
        ).toBe(409);
      }
    }
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it("returns a closed refusal for an unregistered legacy run-number request", async () => {
    const { app, pool, artifacts } = harness();
    const client = {
      query: vi.fn(async (_sql: string) => ({ rows: [], rowCount: 0 })),
      release: vi.fn(),
    };
    vi.mocked(pool.connect).mockResolvedValue(client as never);
    for (const path of [
      RUNTIME_PUBLICATION_PATH,
      `${RUNTIME_PUBLICATION_PATH}/complete`,
    ]) {
      const response = await post(app, path, {
        ...publicationBody,
        releaseOrder: provenance.runNumber,
      });
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({
        error: { code: "runtime_identity_conflict" },
      });
      expect(response.headers.get("Cache-Control")).toBe("no-store");
    }
    expect(artifacts.head).not.toHaveBeenCalled();
    expect(artifacts.presignCreatePut).not.toHaveBeenCalled();
    expect(client.query.mock.calls.some(([sql]) =>
      /\b(?:INSERT|UPDATE)\b/.test(String(sql)),
    )).toBe(false);
    expect(client.release).toHaveBeenCalledTimes(2);
  });

  it("bounds JSON before buffering and returns only a closed error", async () => {
    const { app, pool, verifyOidc } = harness();
    const response = await post(app, RUNTIME_PUBLICATION_PATH, {
      private: "x".repeat(192 * 1024),
    });
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({
      error: { code: "body_too_large" },
    });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(pool.connect).not.toHaveBeenCalled();
    expect(verifyOidc).not.toHaveBeenCalled();
  });

  it("validates the raw base digest before any database work", async () => {
    const { app, pool, verifyOidc } = harness();
    const response = await post(app, RUNTIME_BASE_REGISTRATION_PATH, {
      ...baseBody,
      compatibilitySha256: "d".repeat(64),
    });
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({
      error: { code: "base_compatibility_digest_mismatch" },
    });
    expect(verifyOidc).toHaveBeenCalledWith(
      "synthetic-oidc-token",
      "base_registration",
    );
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it("rejects a parsed compatibility echo that differs from the digest-bound bytes", async () => {
    const { app, pool } = harness();
    const response = await post(app, RUNTIME_BASE_REGISTRATION_PATH, {
      ...baseBody,
      compatibility: { ...compatibility, glibc: "2.40" },
    });
    expect(response.status).toBe(409);
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it.each([
    "base-compatibility.invalid-host.json",
    "base-compatibility.invalid-self-inventory.json",
  ])("rejects B1's invalid base fixture %s", async (filename) => {
    const raw = readFileSync(new URL(filename, fixtures));
    const { app, pool } = harness();
    const response = await post(app, RUNTIME_BASE_REGISTRATION_PATH, {
      ...baseBody,
      compatibilityRawB64: raw.toString("base64"),
      compatibilitySha256: createHash("sha256").update(raw).digest("hex"),
    });
    expect(response.status).toBe(422);
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it.each([
    "not-base64",
    rawCompatibility.toString("base64") + "\n",
    Buffer.from("not JSON").toString("base64"),
  ])("rejects malformed raw compatibility", async (compatibilityRawB64) => {
    const raw = Buffer.from(compatibilityRawB64, "base64");
    const { app, pool } = harness();
    const response = await post(app, RUNTIME_BASE_REGISTRATION_PATH, {
      ...baseBody,
      compatibilityRawB64,
      compatibilitySha256: createHash("sha256").update(raw).digest("hex"),
    });
    expect(response.status).toBe(422);
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it("leaves an explicit non-qualifying scheduling hook until B7", async () => {
    expect(await enqueueRuntimeSmokeQualification(descriptor.runtimeId)).toBe(
      "not_configured",
    );
  });
});

describe("runtime staff authority", () => {
  it.each([undefined, null, "support_admin"])(
    "denies non-engineering staff before database access (%s)",
    async (role) => {
      const pool = { connect: vi.fn() } as unknown as pg.Pool;
      const app = new Hono();
      if (role !== undefined)
        app.use("*", async (c, next) => {
          c.set("user", { staffRole: role });
          await next();
        });
      app.route("/", createRuntimeStaffRoutes(config, pool));
      app.onError((error, c) =>
        c.json(
          { error: { code: (error as HttpError).code } },
          (error as HttpError).status,
        ),
      );
      for (const request of [
        { path: `${RUNTIME_STAFF_PATH}/status`, method: "GET" },
        {
          path: `${RUNTIME_STAFF_PATH}/runtimes/${descriptor.runtimeId}/revoke`,
          method: "POST",
        },
      ]) {
        const response = await app.request(request.path, {
          method: request.method,
        });
        expect(response.status).toBe(role === undefined ? 401 : 404);
        expect(response.headers.get("Cache-Control")).toBe("no-store");
      }
      expect(pool.connect).not.toHaveBeenCalled();
    },
  );

  it.each(["developer", "platform_owner"])(
    "accepts the server's %s role, then validates the action identity",
    async (role) => {
      const pool = { connect: vi.fn() } as unknown as pg.Pool;
      const app = new Hono();
      app.use("*", async (c, next) => {
        c.set("user", { staffRole: role });
        await next();
      });
      app.route("/", createRuntimeStaffRoutes(config, pool));
      app.onError((error, c) =>
        c.json(
          { error: { code: (error as HttpError).code } },
          (error as HttpError).status,
        ),
      );
      const response = await app.request(
        `${RUNTIME_STAFF_PATH}/runtimes/untrusted/revoke`,
        { method: "POST" },
      );
      expect(response.status).toBe(422);
      expect(pool.connect).not.toHaveBeenCalled();
    },
  );
});

describe("runtime router assembly", () => {
  const pool = { connect: vi.fn(), query: vi.fn() } as unknown as pg.Pool;
  const email = { from: null, token: null, apiUrl: "", inviteLinkBase: "" };
  it("uses the supplied shared artifact store and fails closed without it", async () => {
    const head = vi.fn(async () => ({ exists: false, bytes: null }));
    const artifacts: RuntimeArtifactStore = {
      head,
      presignCreatePut: vi.fn(),
      presignGet: vi.fn(),
    };
    const verifyOidc = vi.fn(async () => provenance);
    const app = createApp(config, pool, email, {
      runtimePublication: { artifacts, verifyOidc },
    });
    const response = await post(
      app,
      `${RUNTIME_PUBLICATION_PATH}/complete`,
      publicationBody,
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: {
        code: "runtime_artifact_missing",
        message: "Runtime artifact is missing",
      },
    });
    expect(head).toHaveBeenCalledExactlyOnceWith(
      runtimeArtifactObjectKey(descriptor.runtimeId, descriptor.archiveSha256),
    );
    const unavailable = createApp(config, pool, email, {
      runtimePublication: { artifacts: null, verifyOidc },
    });
    expect(
      (
        await post(
          unavailable,
          `${RUNTIME_PUBLICATION_PATH}/complete`,
          publicationBody,
        )
      ).status,
    ).toBe(503);
    expect(head).toHaveBeenCalledOnce();
  });
  it("mounts disabled CI paths before account auth and staff paths after it", async () => {
    const app = createApp(
      {
        ...config,
        cloudRuntimePublication: {
          ...config.cloudRuntimePublication!,
          enabled: false,
        },
      },
      pool,
      email,
    );
    expect(
      (await app.request(RUNTIME_PUBLICATION_PATH, { method: "POST" })).status,
    ).toBe(404);
    const staffResponse = await app.request(`${RUNTIME_STAFF_PATH}/status`);
    expect(staffResponse.status).toBe(401);
    expect(staffResponse.headers.get("Cache-Control")).toBe("no-store");
    expect(
      (
        await app.request(
          `${RUNTIME_STAFF_PATH}/runtimes/${descriptor.runtimeId}/revoke`,
          { method: "POST" },
        )
      ).status,
    ).toBe(401);
  });
  it("mounts enabled CI paths with their own verifier and preserves migration barriers", async () => {
    const verifyOidc = vi.fn(async () => {
      throw new Error("invalid token");
    });
    const app = createApp(config, pool, email, {
      runtimePublication: { verifyOidc },
    });
    expect(
      (await post(app, RUNTIME_PUBLICATION_PATH, publicationBody)).status,
    ).toBe(401);
    expect(verifyOidc).toHaveBeenCalledOnce();
    const pending = createApp(config, pool, email, {
      migrationStatus: {
        state: "controlled_migration_pending",
        migration: "0025_cloud_workspace_controlled_reset.sql",
        phase: "controlled",
      } as never,
    });
    for (const path of [
      RUNTIME_PUBLICATION_PATH,
      `${RUNTIME_PUBLICATION_PATH}/complete`,
      RUNTIME_BASE_REGISTRATION_PATH,
      `${RUNTIME_STAFF_PATH}/status`,
    ]) {
      expect(
        (
          await pending.request(path, {
            method: path.endsWith("status") ? "GET" : "POST",
          })
        ).status,
      ).toBe(503);
    }
  });
});
