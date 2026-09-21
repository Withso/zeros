import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { PassThrough, Readable } from "node:stream";

import { describe, expect, it, vi } from "vitest";
import { PROTOCOL_VERSION } from "@zeros/protocol/version";
import {
  CLOUD_WORKSPACE_ENGINE_PROTOCOL_VERSION,
  MIN_CLOUD_WORKSPACE_ENGINE_PROTOCOL_VERSION,
} from "../../apps/control-plane/src/cloud-workspaces/engine-protocol-version";

import {
  CLOUD_WORKSPACE_SETUP_AUDIENCE,
  CLOUD_WORKSPACE_SETUP_MATERIALS_AUDIENCE,
  CLOUD_WORKSPACE_UNPRIVILEGED_SET_PRIV_ARGS,
  compareCloudWorkspaceRecoveryPath,
  parseCloudWorkspaceEngineReadiness,
  parseCloudWorkspaceSetupMaterials,
  parseCloudWorkspaceSetupRequest,
  recoverInterruptedCloudWorkspaceClone,
  repositoryIdentityMatchesSetup,
  writeAllSync,
  readCloudWorkspaceSetupInput,
  cloudWorkspaceImageAdmissionChecks,
  cloudWorkspaceImageAdmissionDiagnostic,
  parseRecoveryManifestPage,
  parseRecoveryDesignSelection,
} from "../cloud-workspace-validation/sandbox/setup-cloud-workspace.mjs";
import {
  CLOUD_WORKER_SUPERVISOR_AUDIENCE,
  CloudWorkerSupervisor,
  parseCloudWorkerSupervisorRequest,
} from "../cloud-workspace-validation/sandbox/cloud-worker-supervisor.mjs";

const NOW = 1_800_000_000_000;
const WORKSPACE_ID = "00000000-0000-4000-8000-000000000001";
const ORGANIZATION_ID = "00000000-0000-4000-8000-000000000002";
const SETUP_RUN_ID = "00000000-0000-4000-8000-000000000003";
const ENGINE_INSTANCE_ID = "00000000-0000-4000-8000-000000000004";
const execFileAsync = promisify(execFile);

describe("versioned cloud recovery manifests", () => {
  const checkpointId = "11111111-1111-4111-8111-111111111111";
  const blob = { blobId: "22222222-2222-4222-8222-222222222222", contentSha256: "a".repeat(64), sizeBytes: 12 };
  const page = { version: 2, audience: "zeros-cloud-workspace-recovery-manifest-v2", checkpointId, contentRevision: 1,
    gitBaseCommit: "a".repeat(40), gitHeadRef: null, fileCount: 0, totalBytes: 0, entries: [], nextAfterPath: null,
    manifest: blob, artifacts: [blob] };
  it("validates native artifact descriptors and preserves the v1 wire contract", () => {
    expect(parseRecoveryManifestPage(page, { checkpointId, contentRevision: 1 }, null)).toEqual(page);
    const { manifest: _manifest, artifacts: _artifacts, ...legacy } = page;
    legacy.version = 1; legacy.audience = "zeros-cloud-workspace-recovery-manifest-v1";
    expect(parseRecoveryManifestPage(legacy, { checkpointId, contentRevision: 1 }, null)).toEqual(legacy);
    for (const invalid of [{ ...page, artifacts: [blob, blob] }, { ...page, artifacts: [{ ...blob, sizeBytes: 17 * 1024 * 1024 }] },
      { ...page, manifest: { ...blob, destination: "/root/secret" } }, { ...page, version: 3 }, { ...page, checkpointId: blob.blobId }]) {
      expect(() => parseRecoveryManifestPage(invalid, { checkpointId, contentRevision: 1 }, null)).toThrow();
    }
  });
  it("restores only validated private Design selection fields", () => {
    expect(parseRecoveryDesignSelection({ directory_id: "design_test" })).toEqual({ directory_id: "design_test" });
    expect(parseRecoveryDesignSelection({ directory: "apps/design" })).toEqual({ directory: "apps/design" });
    for (const value of [{ env: { TOKEN: "private" } }, { directory: "../outside" }, { directory: "/root" }, { directory_id: "../../secret" },
      { directory: ".zeros/credentials" }, { directory: "C:/host" }, { directory: "design/../secret" }, { directory_id: "design_test", token: "private" }]) {
      expect(() => parseRecoveryDesignSelection(value)).toThrow();
    }
  });
});

describe("cloud image admission diagnostics", () => {
  it("retains only a closed human-service failure phase for cold setup diagnosis", () => {
    for (const phase of ["configuration", "worker-launch", "handshake", "identity", "exec-pty", "pty", "sftp", "namespace-retirement"])
      expect(cloudWorkspaceImageAdmissionDiagnostic({ qualification: { humanServices: { secure: false, phase, error: "private output" } } })).toMatchObject({ humanServicePhase: phase });
    for (const phase of [undefined, "secret arbitrary provider output", {}, "a".repeat(1000)])
      expect(cloudWorkspaceImageAdmissionDiagnostic({ qualification: { humanServices: { secure: false, phase } } })).toMatchObject({ humanServicePhase: null });
  });
  it("distinguishes cold runtime failures using only bounded known probe names", () => {
    expect(cloudWorkspaceImageAdmissionDiagnostic({ qualification: {
      identity: { secure: true, checks: [{ name: "fixed-engine-user-namespace", status: "pass" }] },
      workload: { secure: false, checks: [
        { name: "cloud-private-container-execution", status: "fail", detail: "credential material" },
        { name: "private credential in a forged probe name", status: "fail" },
      ] },
      capture: null,
    } })).toMatchObject({ identity: true, workload: false, capture: false,
      failedProbes: ["cloud-private-container-execution"] });
    expect(cloudWorkspaceImageAdmissionDiagnostic(null)).toMatchObject({
      identity: false, workload: false, capture: false, failedProbes: [],
    });
  });
  it("retains setup and helper failures when all workload probes pass", () => {
    const diagnostic = cloudWorkspaceImageAdmissionDiagnostic({
      qualification: { identity: { secure: true }, workload: { secure: true }, capture: { secure: true } },
      setupQualification: { secure: false, unprivileged: true, detachedDescendantsRetired: false, timeoutRetired: true, error: "private output" },
      helpers: { trusted: { node: true, bwrap: false, "private forged name": false },
        deploymentTrusted: { engineTree: false, runtimeTree: true, "private forged name": false } },
    });
    expect(diagnostic).toMatchObject({ setup: { secure: false, unprivileged: true, detachedDescendantsRetired: false, timeoutRetired: true },
      failedHelpers: ["bwrap", "engineTree"] });
    expect(JSON.stringify(diagnostic)).not.toContain("private");
  });
  it("identifies failed gates without copying provider output or credential material", () => {
    const checks = cloudWorkspaceImageAdmissionChecks(
      { image: { sourceCommit: "a".repeat(40), ref: "snapshot-pinned" } },
      { version: 1, profile: "zeros-cloud-worker-v1" },
      { code: 1, timedOut: false, overflow: false },
      {
        version: 1,
        profile: "zeros-cloud-worker-v1",
        qualified: false,
        metadata: { build: { source: { commit: "a".repeat(40) } } },
        helpers: {
          deploymentTrusted: { setupHelper: true, workerSupervisor: true },
        },
        resources: { finite: true },
        qualification: { secure: false, error: "private provider body" },
      },
    );
    expect(checks).toMatchObject({
      execution: false,
      report: true,
      profile: true,
      qualified: false,
      source: true,
      build: true,
      helpers: true,
      resources: true,
      runtime: false,
    });
    expect(
      Object.values(checks).every((value) => typeof value === "boolean"),
    ).toBe(true);
    expect(JSON.stringify(checks)).not.toContain("private provider body");
  });

  it("records malformed attestation as a closed gate", () => {
    const checks = cloudWorkspaceImageAdmissionChecks(
      { image: { sourceCommit: "a".repeat(40), ref: "snapshot-pinned" } },
      { version: 2, profile: "zeros-cloud-worker-v2" },
      { code: 0, timedOut: false, overflow: false },
      null,
    );
    expect(checks.report).toBe(false);
    expect(checks.resources).toBe(false);
    expect(checks.runtime).toBe(false);
  });
});

describe("cloud setup credential transport", () => {
  it("reads a bounded request from SSH stdin without an environment or argv secret", async () => {
    const encoded = Buffer.from("test-request").toString("base64url");
    await expect(
      readCloudWorkspaceSetupInput({
        args: ["--stdin"],
        env: {},
        input: Readable.from([encoded.slice(0, 3), encoded.slice(3)]),
      }),
    ).resolves.toBe(encoded);
  });

  it("retains the existing environment transport and consumes its value once", async () => {
    const env = { ZEROS_CLOUD_WORKSPACE_SETUP_B64: "encoded-request" };
    await expect(
      readCloudWorkspaceSetupInput({ args: [], env, input: Readable.from([]) }),
    ).resolves.toBe("encoded-request");
    expect(env).toEqual({});
  });

  it("rejects ambiguous input, unexpected arguments, oversized and stalled stdin", async () => {
    await expect(
      readCloudWorkspaceSetupInput({
        args: ["--stdin"],
        env: { ZEROS_CLOUD_WORKSPACE_SETUP_B64: "secret" },
        input: Readable.from(["different"]),
      }),
    ).rejects.toBeDefined();
    await expect(
      readCloudWorkspaceSetupInput({
        args: ["--stdin", "ignored"],
        env: {},
        input: Readable.from([]),
      }),
    ).rejects.toBeDefined();
    await expect(
      readCloudWorkspaceSetupInput({
        args: ["--stdin"],
        env: {},
        input: Readable.from(["a".repeat(64 * 1024)]),
      }),
    ).rejects.toBeDefined();
    const stalled = new PassThrough();
    await expect(
      readCloudWorkspaceSetupInput({
        args: ["--stdin"],
        env: {},
        input: stalled,
        timeoutMs: 10,
      }),
    ).rejects.toBeDefined();
    expect(stalled.destroyed).toBe(true);
  });
});

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function requestDocument() {
  return {
    version: 1,
    audience: CLOUD_WORKSPACE_SETUP_AUDIENCE,
    issuedAtMs: NOW,
    admission: {
      id: "00000000-0000-4000-8000-000000000005",
      token: `zws_${"A".repeat(43)}`,
      endpoint:
        "https://control.example.test/internal/v1/cloud-workspaces/setup/admission",
      expiresAtMs: NOW + 120_000,
    },
    execution: {
      workspaceId: WORKSPACE_ID,
      organizationId: ORGANIZATION_ID,
      generation: 2,
      setupRunId: SETUP_RUN_ID,
      executionFence: 7,
    },
    expected: {
      imageRef: "snapshot:zeros-cloud-v2",
      imageSourceCommit: "a".repeat(40),
      repositoryRevision: "main",
      settingsVersion: 3,
      settingsSha256: "b".repeat(64),
    },
  };
}

function settingsDocument() {
  return {
    schemaVersion: 1,
    values: { agent: { defaultModel: "gpt-5" } },
    secretRefs: [
      {
        id: "00000000-0000-4000-8000-000000000006",
        name: "PACKAGE_TOKEN",
      },
    ],
    setupCommands: [{ command: "pnpm install", timeoutSeconds: 300 }],
  };
}

function materialDocument() {
  const request = requestDocument();
  const settingsBytes = Buffer.from(JSON.stringify(settingsDocument()), "utf8");
  return {
    version: 1,
    audience: CLOUD_WORKSPACE_SETUP_MATERIALS_AUDIENCE,
    execution: request.execution,
    image: {
      ref: request.expected.imageRef,
      sourceCommit: request.expected.imageSourceCommit,
    },
    repository: {
      forge: "github.com",
      owner: "withso",
      name: "zeros",
      revision: "main",
      cloneUrl: "https://github.com/withso/zeros.git",
      credential: {
        username: "x-access-token",
        token: "ghs_short_lived_repository_token",
        expiresAtMs: NOW + 60 * 60_000,
      },
    },
    settings: {
      version: request.expected.settingsVersion,
      snapshotSha256: request.expected.settingsSha256,
      documentB64: settingsBytes.toString("base64url"),
      documentSha256: createHash("sha256").update(settingsBytes).digest("hex"),
      setupEnvironment: [
        { name: "PACKAGE_TOKEN", value: "short-lived-package-token" },
      ],
      setupCommands: [{ command: "pnpm install", timeoutSeconds: 300 }],
    },
    engine: {
      instanceId: ENGINE_INSTANCE_ID,
      protocolVersion: PROTOCOL_VERSION,
      port: 39_393,
      bridgeToken: `zwb_${"B".repeat(43)}`,
      readinessProbeToken: `zwr_${"R".repeat(43)}`,
      ownerSubject: "workos|owner",
      accountAuth: {
        jwksUrl: "https://auth.example.test/.well-known/jwks.json",
        audience: "zeros-cloud",
        issuers: ["https://auth.example.test/"],
        contract: "zeros-access-v1",
        clientId: "client_desktop_example",
      },
      registration: {
        endpoint:
          "https://control.example.test/internal/v1/cloud-workspaces/engine/register",
        token: `zws_${"C".repeat(43)}`,
        expiresAtMs: NOW + 61 * 60_000,
      },
    },
  };
}

function runtimeB64() {
  const material = materialDocument();
  return encode({
    version: 1,
    audience: "zeros-cloud-engine-runtime-v1",
    execution: material.execution,
    engine: {
      instanceId: material.engine.instanceId,
      protocolVersion: material.engine.protocolVersion,
      readinessProbeToken: material.engine.readinessProbeToken,
    },
    registration: material.engine.registration,
  });
}

describe("cloud workspace image setup protocol", () => {
  it("keeps the independently deployed setup default aligned with the shared protocol", () => {
    expect(CLOUD_WORKSPACE_ENGINE_PROTOCOL_VERSION).toBe(PROTOCOL_VERSION);
    expect(MIN_CLOUD_WORKSPACE_ENGINE_PROTOCOL_VERSION).toBeLessThanOrEqual(
      PROTOCOL_VERSION,
    );
  });

  it("uses the server's UTF-8 byte order for recovery manifest cursors", () => {
    const bmpPrivateUse = "\ue000.txt";
    const supplementary = "\u{10000}.txt";
    expect(
      Buffer.compare(Buffer.from(bmpPrivateUse), Buffer.from(supplementary)),
    ).toBeLessThan(0);
    expect(
      compareCloudWorkspaceRecoveryPath(bmpPrivateUse, supplementary),
    ).toBeLessThan(0);
    expect(
      compareCloudWorkspaceRecoveryPath(supplementary, bmpPrivateUse),
    ).toBeGreaterThan(0);
    expect(
      compareCloudWorkspaceRecoveryPath(bmpPrivateUse, bmpPrivateUse),
    ).toBe(0);
  });

  it("writes every byte when a synchronous write makes partial progress", () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    const written: number[] = [];

    writeAllSync(17, bytes, (_descriptor, value, offset, length) => {
      const progress = Math.min(2, length);
      written.push(...value.subarray(offset, offset + progress));
      return progress;
    });

    expect(written).toEqual([...bytes]);
  });

  it("rejects invalid synchronous write progress", () => {
    for (const progress of [0, -1, 0.5, 2]) {
      let caught: unknown;
      try {
        writeAllSync(17, new Uint8Array([1]), () => progress);
      } catch (error) {
        caught = error;
      }
      expect(caught).toMatchObject({ code: "checkpoint_restore_invalid" });
    }
  });

  it("prevents setup and Git subprocesses from regaining image privileges", () => {
    expect(CLOUD_WORKSPACE_UNPRIVILEGED_SET_PRIV_ARGS).toEqual(
      expect.arrayContaining([
        "--no-new-privs",
        "--bounding-set=-all",
        "--inh-caps=-all",
        "--ambient-caps=-all",
        "--pdeathsig=SIGKILL",
        "--clear-groups",
      ]),
    );
  });

  it("scopes the setup credential askpass helper to GitHub HTTPS prompts", async () => {
    const askpass = new URL(
      "../cloud-workspace-validation/sandbox/cloud-git-askpass.mjs",
      import.meta.url,
    );
    const env = {
      ...process.env,
      ZEROS_GIT_ASKPASS_HOST: "github.com",
      ZEROS_GIT_ASKPASS_PASSWORD: "short-lived-installation-token",
      ZEROS_GIT_ASKPASS_USERNAME: "x-access-token",
    };
    const accepted = await execFileAsync(
      process.execPath,
      [askpass.pathname, "Password for 'https://x-access-token@github.com': "],
      { env },
    );
    expect(accepted.stdout.trim()).toBe("short-lived-installation-token");

    await expect(
      execFileAsync(
        process.execPath,
        [
          askpass.pathname,
          "Password for 'https://x-access-token@github.com.evil.test': ",
        ],
        { env },
      ),
    ).rejects.toMatchObject({
      stdout: expect.not.stringContaining("short-lived-installation-token"),
    });
  });

  it("rejects a repository identity changed by setup commands", () => {
    const commit = "a".repeat(40);
    expect(repositoryIdentityMatchesSetup(commit, commit)).toBe(true);
    expect(repositoryIdentityMatchesSetup(commit, "b".repeat(40))).toBe(false);
    expect(repositoryIdentityMatchesSetup(commit, null)).toBe(false);
  });

  it("recovers the image seed after interruption between checkout renames", () => {
    const root = mkdtempSync(join(tmpdir(), "zeros-cloud-clone-recovery-"));
    const targetDirectory = join(root, "zeros");
    const seededRepositoryBackup = join(root, "seed");
    mkdirSync(seededRepositoryBackup, { mode: 0o700 });
    try {
      expect(
        recoverInterruptedCloudWorkspaceClone({
          targetDirectory,
          seededRepositoryBackup,
          expectedUid: process.getuid?.() ?? 0,
        }),
      ).toBe(true);
      expect(existsSync(targetDirectory)).toBe(true);
      expect(existsSync(seededRepositoryBackup)).toBe(false);
      expect(
        recoverInterruptedCloudWorkspaceClone({
          targetDirectory,
          seededRepositoryBackup,
          expectedUid: process.getuid?.() ?? 0,
        }),
      ).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("accepts only the canonical, fresh, exact-bound setup request", () => {
    const expected = requestDocument();
    expect(parseCloudWorkspaceSetupRequest(encode(expected), NOW)).toEqual(
      expected,
    );

    for (const invalid of [
      { ...expected, extra: true },
      { ...expected, issuedAtMs: NOW - 16 * 60_000 },
      {
        ...expected,
        admission: {
          ...expected.admission,
          endpoint:
            "https://control.example.test/interactive/workspace/admission",
        },
      },
      {
        ...expected,
        admission: {
          ...expected.admission,
          token: `zws_${"A".repeat(42)}`,
        },
      },
    ]) {
      expect(() =>
        parseCloudWorkspaceSetupRequest(encode(invalid), NOW),
      ).toThrow(/setup request is invalid/i);
    }
  });

  it("accepts version-2 measured resource contracts without accepting a downgrade or unknown resource fields", () => {
    const request = parseCloudWorkspaceSetupRequest(
      encode(requestDocument()),
      NOW,
    );
    const old = materialDocument();
    const resources = {
      architecture: "linux/amd64",
      cpuMillicores: 4000,
      memoryMiB: 8192,
      storageMiB: 40960,
    };
    const current = { ...old, version: 2, image: { ...old.image, resources } };
    expect(
      parseCloudWorkspaceSetupMaterials(current, request, NOW).image.resources,
    ).toEqual(resources);
    for (const invalid of [
      { ...current, version: 1 },
      { ...current, version: 3 },
      { ...current, image: old.image },
      {
        ...current,
        image: { ...current.image, resources: { ...resources, memoryMiB: 0 } },
      },
      {
        ...current,
        image: { ...current.image, resources: { ...resources, skip: true } },
      },
    ])
      expect(() =>
        parseCloudWorkspaceSetupMaterials(invalid, request, NOW),
      ).toThrow(/materials are invalid/);
  });

  it("accepts exact setup materials while rejecting authority injection", () => {
    const request = parseCloudWorkspaceSetupRequest(
      encode(requestDocument()),
      NOW,
    );
    const expected = materialDocument();
    expect(parseCloudWorkspaceSetupMaterials(expected, request, NOW)).toEqual({
      ...expected,
      settings: {
        ...expected.settings,
        document: settingsDocument(),
      },
    });

    const cases = [
      { ...expected, debugCredential: "must-not-cross" },
      {
        ...expected,
        engine: {
          ...expected.engine,
          registration: {
            ...expected.engine.registration,
            endpoint:
              "https://evil.example.test/internal/v1/cloud-workspaces/engine/register",
          },
        },
      },
      {
        ...expected,
        settings: {
          ...expected.settings,
          setupEnvironment: [
            { name: "ZEROS_CLOUD_TOKEN", value: "authority-smuggling" },
          ],
        },
      },
      {
        ...expected,
        repository: {
          ...expected.repository,
          cloneUrl: "https://github.com/withso/other.git",
        },
      },
      {
        ...expected,
        repository: {
          ...expected.repository,
          credential: {
            ...expected.repository.credential,
            expiresAtMs: NOW + 5 * 60_000 - 1,
          },
        },
      },
    ];
    for (const invalid of cases) {
      expect(() =>
        parseCloudWorkspaceSetupMaterials(invalid, request, NOW),
      ).toThrow(/invalid/i);
    }
  });

  it("requires exact durable engine readiness", () => {
    const material = materialDocument();
    const readiness = {
      version: 1,
      audience: "zeros-cloud-engine-readiness-v1",
      ready: true,
      engine: {
        version: 1,
        instanceId: ENGINE_INSTANCE_ID,
        protocolVersion: PROTOCOL_VERSION,
        health: "ready",
        durableRecordConnected: true,
      },
    };
    expect(parseCloudWorkspaceEngineReadiness(readiness, material)).toEqual(
      readiness.engine,
    );
    expect(
      parseCloudWorkspaceEngineReadiness(
        {
          ...readiness,
          engine: { ...readiness.engine, instanceId: WORKSPACE_ID },
        },
        material,
      ),
    ).toBeNull();
    expect(
      parseCloudWorkspaceEngineReadiness(
        { ...readiness, publicUrl: "must-not-be-accepted" },
        material,
      ),
    ).toBeNull();
  });
});

describe("cloud worker supervisor protocol", () => {
  function startRequest() {
    const material = materialDocument();
    return {
      version: 1,
      audience: CLOUD_WORKER_SUPERVISOR_AUDIENCE,
      operation: "start",
      session: `zsp_${"S".repeat(43)}`,
      environment: {
        accountAudience: material.engine.accountAuth.audience,
        accountClientId: material.engine.accountAuth.clientId,
        accountContract: material.engine.accountAuth.contract,
        accountIssuers: material.engine.accountAuth.issuers,
        accountJwksUrl: material.engine.accountAuth.jwksUrl,
        bridgeToken: material.engine.bridgeToken,
        ownerSubject: material.engine.ownerSubject,
        port: material.engine.port,
        runtimeB64: runtimeB64(),
      },
    };
  }

  it("admits only prepare or an exact fixed engine environment", () => {
    expect(
      parseCloudWorkerSupervisorRequest({
        version: 1,
        audience: CLOUD_WORKER_SUPERVISOR_AUDIENCE,
        operation: "prepare",
      }),
    ).toMatchObject({ operation: "prepare" });
    expect(parseCloudWorkerSupervisorRequest(startRequest())).toMatchObject({
      operation: "start",
      session: `zsp_${"S".repeat(43)}`,
    });

    for (const invalid of [
      { ...startRequest(), command: "/bin/sh" },
      {
        ...startRequest(),
        environment: {
          ...startRequest().environment,
          LD_PRELOAD: "/workspace/owned.so",
        },
      },
      {
        ...startRequest(),
        environment: {
          ...startRequest().environment,
          accountIssuers: ["https://auth.example.test/,https://evil.test/"],
        },
      },
      {
        ...startRequest(),
        environment: {
          ...startRequest().environment,
          accountClientId: null,
        },
      },
      { ...startRequest(), session: `zsp_${"S".repeat(42)}` },
    ]) {
      expect(parseCloudWorkerSupervisorRequest(invalid)).toBeNull();
    }
  });

  it("makes each prepared launch session one-use and rejects stale helpers", async () => {
    const children: EventEmitter[] = [];
    const spawnCalls: Array<{
      file: string;
      args: readonly string[];
      options: {
        cwd: string;
        detached: boolean;
        stdio: string;
        env: Record<string, string>;
      };
    }> = [];
    const supervisor = new CloudWorkerSupervisor({
      spawnProcess: (
        file: string,
        args: readonly string[],
        options: (typeof spawnCalls)[number]["options"],
      ) => {
        spawnCalls.push({ file, args, options });
        const child = Object.assign(new EventEmitter(), {
          pid: 91_337,
          exitCode: null,
          signalCode: null,
          unref: () => undefined,
        });
        children.push(child);
        queueMicrotask(() => child.emit("spawn"));
        return child;
      },
    });
    const prepared = await supervisor.apply({
      version: 1,
      audience: CLOUD_WORKER_SUPERVISOR_AUDIENCE,
      operation: "prepare",
    });
    expect(prepared).toMatchObject({ outcome: "prepared" });

    const parsed = parseCloudWorkerSupervisorRequest({
      ...startRequest(),
      session: prepared.session,
    });
    expect(parsed).not.toBeNull();
    await expect(
      supervisor.apply({ ...parsed!, session: `zsp_${"X".repeat(43)}` }),
    ).resolves.toMatchObject({ outcome: "rejected" });
    await expect(supervisor.apply(parsed!)).resolves.toMatchObject({
      outcome: "started",
      pid: 91_337,
    });
    await expect(supervisor.apply(parsed!)).resolves.toMatchObject({
      outcome: "rejected",
    });
    expect(children).toHaveLength(1);
    expect(spawnCalls).toEqual([
      {
        file: "/opt/zeros-runtime/bin/start-engine.sh",
        args: [],
        options: {
          cwd: "/",
          detached: true,
          stdio: "ignore",
          env: {
            HOME: "/root",
            LANG: "C.UTF-8",
            PATH: "/opt/zeros-runtime/bin:/usr/bin:/bin:/usr/sbin:/sbin",
            ZEROS_ACCOUNT_JWT_AUD: "zeros-cloud",
            ZEROS_ACCOUNT_JWT_CLIENT_ID: "client_desktop_example",
            ZEROS_ACCOUNT_JWT_CONTRACT: "zeros-access-v1",
            ZEROS_ACCOUNT_JWT_ISS: "https://auth.example.test/",
            ZEROS_ACCOUNT_JWT_JWKS_URL:
              "https://auth.example.test/.well-known/jwks.json",
            ZEROS_CLOUD_OWNER_SUB: "workos|owner",
            ZEROS_CLOUD_PORT: "39393",
            ZEROS_CLOUD_RUNTIME_B64: runtimeB64(),
            ZEROS_CLOUD_SETUP_BOOT: "1",
            ZEROS_CLOUD_TOKEN: `zwb_${"B".repeat(43)}`,
            ZEROS_REQUIRE_ACCOUNT: "1",
          },
        },
      },
    ]);
  });

  it("reaps the engine scope even when its launcher exited or was lost", async () => {
    for (const child of [null, { exitCode: 0, signalCode: null }]) {
      const retire = vi.fn().mockResolvedValue(undefined);
      const supervisor = new CloudWorkerSupervisor({ engineScope: { retire } });
      supervisor.child = child;
      await supervisor.apply({ operation: "prepare" });
      expect(retire).toHaveBeenCalledOnce();
    }
  });

  it("retires both setup and engine descendants before issuing launch authority", async () => {
    const engine = vi
      .fn()
      .mockRejectedValue(new Error("engine retirement failed"));
    const setup = vi.fn().mockResolvedValue(undefined);
    const supervisor = new CloudWorkerSupervisor({
      engineScope: { retire: engine },
      setupScope: { retire: setup },
    });
    await expect(supervisor.apply({ operation: "prepare" })).rejects.toThrow(
      /engine retirement failed/,
    );
    expect(setup).toHaveBeenCalledOnce();
    engine.mockResolvedValue(undefined);
    setup.mockRejectedValue(new Error("setup retirement failed"));
    await expect(supervisor.apply({ operation: "prepare" })).rejects.toThrow(
      /setup retirement failed/,
    );
  });

  it("does not mint a new launch session without confirmed descendant retirement", async () => {
    const retire = vi
      .fn()
      .mockRejectedValue(new Error("retirement unconfirmed"));
    const supervisor = new CloudWorkerSupervisor({ engineScope: { retire } });
    supervisor.session = `zsp_${"S".repeat(43)}`;
    await expect(supervisor.apply({ operation: "prepare" })).rejects.toThrow(
      /retirement unconfirmed/,
    );
    expect(supervisor.session).toBeNull();
  });
});
