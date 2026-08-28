import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import {
  CLOUD_WORKSPACE_SETUP_AUDIENCE,
  CLOUD_WORKSPACE_SETUP_MATERIALS_AUDIENCE,
  CLOUD_WORKSPACE_UNPRIVILEGED_SET_PRIV_ARGS,
  parseCloudWorkspaceEngineReadiness,
  parseCloudWorkspaceSetupMaterials,
  parseCloudWorkspaceSetupRequest,
  recoverInterruptedCloudWorkspaceClone,
  repositoryIdentityMatchesSetup,
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
      protocolVersion: 11,
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
        protocolVersion: 11,
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
        file: "/usr/local/bin/start-engine.sh",
        args: [],
        options: {
          cwd: "/",
          detached: true,
          stdio: "ignore",
          env: {
            HOME: "/root",
            LANG: "C.UTF-8",
            PATH: "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
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
});
