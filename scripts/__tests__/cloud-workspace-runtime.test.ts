import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

import {
  assertCloudStateMatchesSnapshot,
  acknowledgeQualifiedCloudGithubRefreshRequest,
  cloudRuntimeTargetFromValidationState,
  installQualifiedCloudEngineIngress,
  installQualifiedCloudGithubCredential,
  installQualifiedCloudPreviewLinks,
  readQualifiedCloudGithubRefreshRequest,
  refreshQualifiedCloudEngineIngress,
  refreshQualifiedCloudPreviewLinks,
  revokeCloudEngineIngressState,
  rotateQualifiedCloudPreviewLinks,
  revokeCloudPreviewLinks,
  verifyCloudRuntimeAttestation,
} from "../cloud-workspace-validation/runtime";
import {
  imageContractSha256,
  NODE_BASE_IMAGE,
  repositoryUrlSha256,
  ZEROS_REPO_REF,
  type CloudSnapshotAttestation,
  type CloudValidationState,
} from "../cloud-workspace-validation/config";
import { selectCloudPrimaryWorkspaceId } from "../cloud-workspace-validation/lib/workspace-target";

const sourceCommit = "c".repeat(40);
const snapshot: CloudSnapshotAttestation = {
  version: 1,
  snapshotId: "snapshot-id",
  snapshotName: "snapshot-name",
  snapshotImageName: "snapshot-image",
  snapshotState: "active",
  baseImage: NODE_BASE_IMAGE,
  repositoryUrlSha256: repositoryUrlSha256(),
  repositoryRef: ZEROS_REPO_REF,
  sourceCommit,
  imageContractSha256: imageContractSha256(),
  bakedAt: "2026-08-14T00:00:00.000Z",
};

const state: CloudValidationState = {
  sandboxId: "sandbox-id",
  previewUrl: "https://39393-sandbox-id.proxy.daytona.work",
  previewToken: "preview-token",
  cloudToken: "cloud-transport-token-1234",
  region: "test",
  createdAt: "2026-08-14T00:00:00.000Z",
  snapshotId: snapshot.snapshotId,
  snapshotImageName: snapshot.snapshotImageName,
  runtimeAttestationSha256: "a".repeat(64),
};

function report() {
  return {
    version: 1,
    qualified: true,
    profile: "zeros-cloud-worker-v1",
    metadata: {
      build: {
        baseImage: NODE_BASE_IMAGE,
        imageContractSha256: imageContractSha256(),
        source: {
          repositoryUrlSha256: repositoryUrlSha256(),
          ref: ZEROS_REPO_REF,
          commit: sourceCommit,
        },
      },
    },
    resources: {
      finite: true,
    },
    qualification: { secure: true },
  };
}

describe("cloud workspace runtime admission", () => {
  it("rejects a malformed engine listener port before touching the worker", () => {
    const result = spawnSync(
      "bash",
      [
        join(
          process.cwd(),
          "scripts/cloud-workspace-validation/sandbox/start-engine.sh",
        ),
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          ZEROS_CLOUD_PORT: "0",
          ZEROS_CLOUD_TOKEN: "test-only-cloud-token",
        },
      },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/ZEROS_CLOUD_PORT is invalid/);
    expect(result.stderr).not.toMatch(/cloud-worker marker/);
  });

  it("resolves the primary PTY target from the opaque workspace list", () => {
    expect(
      selectCloudPrimaryWorkspaceId({
        workspaces: [
          { id: "ws_other", path: "/must/not/be-used" },
          { id: "local-main", path: "/must/not/be-used-either" },
        ],
      }),
    ).toBe("local-main");
    expect(() =>
      selectCloudPrimaryWorkspaceId({ workspaces: [{ id: "ws_other" }] }),
    ).toThrow(/primary cloud workspace/i);
    expect(() =>
      selectCloudPrimaryWorkspaceId({ workspaces: "not-an-array" }),
    ).toThrow(/workspace list/i);
  });

  it("accepts only the current snapshot identity", () => {
    expect(() =>
      assertCloudStateMatchesSnapshot(state, snapshot),
    ).not.toThrow();
    expect(() =>
      assertCloudStateMatchesSnapshot(
        { ...state, snapshotId: "stale-snapshot" },
        snapshot,
      ),
    ).toThrow(/snapshot identity/i);
  });

  it("requires the image contract, tenant limits, and secure live qualification", () => {
    expect(() =>
      verifyCloudRuntimeAttestation(report(), sourceCommit, 0),
    ).not.toThrow();
    expect(() =>
      verifyCloudRuntimeAttestation(
        { ...report(), qualification: { secure: false } },
        sourceCommit,
        0,
      ),
    ).toThrow(/qualification/i);
    expect(() =>
      verifyCloudRuntimeAttestation(
        { ...report(), resources: { finite: false } },
        sourceCommit,
        0,
      ),
    ).toThrow(/qualification/i);
    expect(() =>
      verifyCloudRuntimeAttestation(report(), sourceCommit, 1),
    ).toThrow(/qualification/i);
  });

  it("mints scoped signed preview links outside the worker and installs only a bounded root payload", async () => {
    const installed: Array<{
      command: string;
      env: Record<string, string> | undefined;
    }> = [];
    const expired: Array<{ port: number; token: string }> = [];
    const sandbox = {
      getSignedPreviewUrl: async (port: number, expiresInSeconds?: number) => ({
        sandboxId: "sandbox-id",
        port,
        token: `signed-preview-token-${port}`,
        url: `https://${port}-signed-preview-token-${port}.proxy.daytona.work/`,
        expiresInSeconds,
      }),
      expireSignedPreviewUrl: async (port: number, token: string) => {
        expired.push({ port, token });
      },
      process: {
        executeCommand: async (
          command: string,
          _cwd?: string,
          env?: Record<string, string>,
        ) => {
          installed.push({ command, env });
          return { exitCode: 0, result: "installed" };
        },
      },
    };

    const grant = await installQualifiedCloudPreviewLinks(sandbox as never, {
      ports: [41_000, 41_001],
      expiresInSeconds: 60,
      now: 1_800_000_000_000,
      generation: "test-preview-generation-1234",
    });
    expect(grant).toEqual({
      generation: "test-preview-generation-1234",
      expiresAt: 1_800_000_060_000,
      grants: [
        { port: 41_000, token: "signed-preview-token-41000" },
        { port: 41_001, token: "signed-preview-token-41001" },
      ],
    });
    expect(installed).toHaveLength(1);
    expect(installed[0].command).toBe(
      "/usr/local/bin/node /usr/local/lib/zeros/install-cloud-preview-links.mjs",
    );
    expect(installed[0].command).not.toContain("signed-preview-token");
    expect(Object.keys(installed[0].env ?? {})).toEqual([
      "ZEROS_CLOUD_PREVIEW_LINKS_B64",
    ]);
    const encoded = installed[0].env?.ZEROS_CLOUD_PREVIEW_LINKS_B64 ?? "";
    const document = JSON.parse(
      Buffer.from(encoded, "base64url").toString("utf8"),
    ) as { links: Array<Record<string, unknown>> };
    expect(document.links).toEqual([
      {
        port: 41_000,
        signedUrl: "https://41000-signed-preview-token-41000.proxy.daytona.work/",
      },
      {
        port: 41_001,
        signedUrl: "https://41001-signed-preview-token-41001.proxy.daytona.work/",
      },
    ]);

    await revokeCloudPreviewLinks(sandbox as never, grant);
    expect(expired).toEqual([
      { port: 41_000, token: "signed-preview-token-41000" },
      { port: 41_001, token: "signed-preview-token-41001" },
    ]);
  });

  it("uses a browser-compatible signed engine ingress and rotates it crash-safely", async () => {
    const events: string[] = [];
    let mint = 0;
    const sandbox = {
      getSignedPreviewUrl: async (port: number, expiresInSeconds?: number) => {
        mint += 1;
        events.push(`mint:${mint}:${expiresInSeconds}`);
        return {
          sandboxId: "sandbox-id",
          port,
          token: `engine-signed-token-${mint}`,
          url: `https://${port}-engine-signed-token-${mint}.proxy.daytona.work/`,
        };
      },
      expireSignedPreviewUrl: async (port: number, token: string) => {
        events.push(`revoke:${port}:${token}`);
      },
    };
    const now = 1_800_000_000_000;
    const first = await installQualifiedCloudEngineIngress(sandbox as never, {
      now,
      expiresInSeconds: 60,
      generation: "engine-ingress-generation-one",
    });
    const firstState: CloudValidationState = {
      ...state,
      previewUrl: first.url,
      previewToken: first.token,
      engineIngress: first,
    };
    const persisted: CloudValidationState[] = [];
    const rotated = await refreshQualifiedCloudEngineIngress(
      sandbox as never,
      firstState,
      {
        force: true,
        now: now + 1_000,
        expiresInSeconds: 60,
        generation: "engine-ingress-generation-two",
        persist: (value) => {
          events.push(
            value.engineIngressTransition ? "persist:pending" : "persist:ready",
          );
          persisted.push(value);
        },
      },
    );

    expect(events.slice(0, 4)).toEqual([
      "mint:1:60",
      "mint:2:60",
      "persist:pending",
      "persist:ready",
    ]);
    expect(rotated.previewUrl).toBe(
      "https://39393-engine-signed-token-2.proxy.daytona.work/",
    );
    expect(rotated.previewToken).toBe("engine-signed-token-2");
    expect(rotated.engineIngress?.retiring).toEqual([
      {
        generation: "engine-ingress-generation-one",
        expiresAt: now + 60_000,
        port: 39_393,
        token: "engine-signed-token-1",
      },
    ]);
    expect(rotated.engineIngressTransition).toBeUndefined();
    expect(persisted[0].engineIngress).toBe(first);

    const target = cloudRuntimeTargetFromValidationState(rotated, now + 2_000);
    expect(target).toEqual({
      kind: "cloud",
      url: "wss://39393-engine-signed-token-2.proxy.daytona.work/ws",
      cloudToken: "cloud-transport-token-1234",
      expiresAt: now + 61_000,
    });
    expect(new URL(target.url).search).toBe("");

    await revokeCloudEngineIngressState(sandbox as never, rotated);
    expect(events).toContain("revoke:39393:engine-signed-token-2");
    expect(events).toContain("revoke:39393:engine-signed-token-1");
  });

  it("installs an owner-bound GitHub working copy without persisting or logging it", async () => {
    const calls: Array<{
      command: string;
      env: Record<string, string> | undefined;
    }> = [];
    const sandbox = {
      process: {
        executeCommand: async (
          command: string,
          _cwd?: string,
          env?: Record<string, string>,
        ) => {
          calls.push({ command, env });
          return { exitCode: 0, result: "installed" };
        },
      },
    };
    const summary = await installQualifiedCloudGithubCredential(
      sandbox as never,
      {
        ownerSubject: "auth0|owner",
        credential: {
          method: "pat",
          accessToken: "github_pat_cloud-working-copy",
          gitHost: "github.com",
          gitHttpUsername: "x-access-token",
          login: "octocat",
        },
      },
      {
        now: 1_800_000_000_000,
        expiresInSeconds: 60,
        generation: "runtime-github-generation-1234",
      },
    );
    expect(summary).toEqual({
      generation: "runtime-github-generation-1234",
      expiresAt: 1_800_000_060_000,
      method: "pat",
      configured: true,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe(
      "/usr/local/bin/node /usr/local/lib/zeros/install-cloud-github-credential.mjs",
    );
    expect(calls[0].command).not.toContain("github_pat");
    expect(Object.keys(calls[0].env ?? {})).toEqual([
      "ZEROS_CLOUD_GITHUB_CREDENTIAL_B64",
      "ZEROS_CLOUD_OWNER_SUB",
    ]);
    expect(calls[0].env?.ZEROS_CLOUD_OWNER_SUB).toBe("auth0|owner");
    const document = JSON.parse(
      Buffer.from(
        calls[0].env?.ZEROS_CLOUD_GITHUB_CREDENTIAL_B64 ?? "",
        "base64url",
      ).toString("utf8"),
    ) as Record<string, unknown>;
    expect(document).toMatchObject({
      audience: "zeros-cloud-github-credential-v1",
      method: "pat",
      ownerSubjectSha256:
        "69880226a75aa920515d61cb3be996e768bc525bf096ff0a7ee149cc01bae318",
    });
    expect(JSON.stringify(state)).not.toContain(
      "github_pat_cloud-working-copy",
    );
  });

  it("reads and generation-acknowledges a secret-free GitHub refresh request", async () => {
    const calls: Array<{
      command: string;
      env: Record<string, string> | undefined;
    }> = [];
    const request = {
      version: 1,
      audience: "zeros-cloud-github-refresh-v1",
      generation: "refresh-request-generation-1234",
      requestedAt: 1_800_000_000_000,
      ownerSubjectSha256:
        "69880226a75aa920515d61cb3be996e768bc525bf096ff0a7ee149cc01bae318",
      method: "github-app",
      reason: "credential-invalid",
    };
    const sandbox = {
      process: {
        executeCommand: async (
          command: string,
          _cwd?: string,
          env?: Record<string, string>,
        ) => {
          calls.push({ command, env });
          return command.endsWith(" read")
            ? { exitCode: 0, result: `${JSON.stringify(request)}\n` }
            : { exitCode: 0, result: "acknowledged\n" };
        },
      },
    };

    await expect(
      readQualifiedCloudGithubRefreshRequest(sandbox as never, "auth0|owner"),
    ).resolves.toEqual(request);
    await expect(
      acknowledgeQualifiedCloudGithubRefreshRequest(
        sandbox as never,
        request.generation,
      ),
    ).resolves.toBe(true);
    expect(calls[0]).toEqual({
      command:
        "/usr/local/bin/node /usr/local/lib/zeros/cloud-github-refresh-request.mjs read",
      env: undefined,
    });
    expect(calls[1]?.command).toBe(
      "/usr/local/bin/node /usr/local/lib/zeros/cloud-github-refresh-request.mjs ack",
    );
    expect(calls[1]?.env).toEqual({
      ZEROS_CLOUD_GITHUB_REFRESH_GENERATION: request.generation,
    });
  });

  it("revokes every minted link when root installation fails", async () => {
    const expired: Array<{ port: number; token: string }> = [];
    const sandbox = {
      getSignedPreviewUrl: async (port: number) => ({
        sandboxId: "sandbox-id",
        port,
        token: `signed-preview-token-${port}`,
        url: `https://${port}-signed-preview-token-${port}.proxy.daytona.work/`,
      }),
      expireSignedPreviewUrl: async (port: number, token: string) => {
        expired.push({ port, token });
      },
      process: {
        executeCommand: async () => ({ exitCode: 1, result: "rejected" }),
      },
    };
    await expect(
      installQualifiedCloudPreviewLinks(sandbox as never, {
        ports: [42_000, 42_001],
        expiresInSeconds: 60,
        now: 1_800_000_000_000,
        generation: "test-preview-generation-5678",
      }),
    ).rejects.toThrow(/preview ingress/i);
    expect(expired).toEqual([
      { port: 42_000, token: "signed-preview-token-42000" },
      { port: 42_001, token: "signed-preview-token-42001" },
    ]);
  });

  it("installs a replacement generation before retaining the old grants for drain", async () => {
    const events: string[] = [];
    const sandbox = {
      getSignedPreviewUrl: async (port: number) => {
        events.push(`mint:${port}`);
        return {
          sandboxId: "sandbox-id",
          port,
          token: `replacement-token-${port}`,
          url: `https://${port}-replacement-token-${port}.proxy.daytona.work/`,
        };
      },
      expireSignedPreviewUrl: async (port: number) => {
        events.push(`revoke:${port}`);
      },
      process: {
        executeCommand: async () => {
          events.push("install");
          return { exitCode: 0, result: "installed" };
        },
      },
    };
    const previous = {
      generation: "previous-preview-generation",
      expiresAt: 1_800_000_120_000,
      grants: [{ port: 41_000, token: "old-token-41000" }],
    };
    const rotated = await rotateQualifiedCloudPreviewLinks(
      sandbox as never,
      previous,
      {
        ports: [41_000],
        expiresInSeconds: 60,
        now: 1_800_000_000_000,
        generation: "replacement-preview-generation",
      },
    );
    expect(events).toEqual(["mint:41000", "install"]);
    expect(rotated).toEqual({
      generation: "replacement-preview-generation",
      expiresAt: 1_800_000_060_000,
      grants: [{ port: 41_000, token: "replacement-token-41000" }],
      retiring: [previous],
    });
  });

  it("retries transient revocation failures and includes retiring generations", async () => {
    const attempts = new Map<string, number>();
    const sandbox = {
      expireSignedPreviewUrl: async (port: number, token: string) => {
        const key = `${port}:${token}`;
        const next = (attempts.get(key) ?? 0) + 1;
        attempts.set(key, next);
        if (next === 1) throw new Error("transient provider failure");
      },
    };
    await revokeCloudPreviewLinks(sandbox as never, {
      generation: "current-preview-generation",
      expiresAt: 1_800_000_060_000,
      grants: [{ port: 41_000, token: "current-token" }],
      retiring: [
        {
          generation: "retiring-preview-generation",
          expiresAt: 1_800_000_030_000,
          grants: [{ port: 41_000, token: "retiring-token" }],
        },
      ],
    });
    expect(attempts).toEqual(
      new Map([
        ["41000:current-token", 2],
        ["41000:retiring-token", 2],
      ]),
    );
  });

  it("journals cloud preview rotation before publishing the new root document", async () => {
    const events: string[] = [];
    const persisted: CloudValidationState[] = [];
    const previous = {
      generation: "previous-preview-generation",
      expiresAt: 1_800_000_010_000,
      grants: [{ port: 41_000, token: "previous-token" }],
    };
    const sandbox = {
      getSignedPreviewUrl: async (port: number) => {
        events.push("mint");
        return {
          sandboxId: "sandbox-id",
          port,
          token: `journal-replacement-token-${port}`,
          url: `https://${port}-journal-replacement-token-${port}.proxy.daytona.work/`,
        };
      },
      expireSignedPreviewUrl: async () => events.push("revoke"),
      process: {
        executeCommand: async () => {
          events.push("install");
          return { exitCode: 0, result: "installed" };
        },
      },
    };
    const refreshed = await refreshQualifiedCloudPreviewLinks(
      sandbox as never,
      { ...state, cloudPreview: previous },
      {
        force: true,
        ports: [41_000],
        expiresInSeconds: 60,
        now: 1_800_000_000_000,
        generation: "journal-preview-generation",
        persist: (value) => {
          events.push(
            value.cloudPreviewTransition ? "persist:pending" : "persist:ready",
          );
          persisted.push(value);
        },
      },
    );
    expect(events).toEqual([
      "mint",
      "persist:pending",
      "install",
      "persist:ready",
    ]);
    expect(persisted[0].cloudPreview).toBe(previous);
    expect(persisted[0].cloudPreviewTransition?.replacement.generation).toBe(
      "journal-preview-generation",
    );
    expect(refreshed.cloudPreviewTransition).toBeUndefined();
    expect(refreshed.cloudPreview?.retiring).toEqual([previous]);
  });

  it("recovers an interrupted preview transition by revoking it before reminting", async () => {
    const events: string[] = [];
    const previous = {
      generation: "previous-preview-generation",
      expiresAt: 1_800_000_120_000,
      grants: [{ port: 41_000, token: "previous-token" }],
    };
    const interrupted = {
      generation: "interrupted-preview-generation",
      expiresAt: 1_800_000_060_000,
      grants: [{ port: 41_000, token: "interrupted-token" }],
    };
    const sandbox = {
      getSignedPreviewUrl: async (port: number) => {
        events.push("mint");
        return {
          sandboxId: "sandbox-id",
          port,
          token: `recovered-replacement-token-${port}`,
          url: `https://${port}-recovered-replacement-token-${port}.proxy.daytona.work/`,
        };
      },
      expireSignedPreviewUrl: async (_port: number, token: string) => {
        events.push(`revoke:${token}`);
      },
      process: {
        executeCommand: async () => {
          events.push("install");
          return { exitCode: 0, result: "installed" };
        },
      },
    };
    await refreshQualifiedCloudPreviewLinks(
      sandbox as never,
      {
        ...state,
        cloudPreview: previous,
        cloudPreviewTransition: {
          startedAt: 1_799_999_999_000,
          replacement: interrupted,
        },
      },
      {
        force: true,
        ports: [41_000],
        expiresInSeconds: 60,
        now: 1_800_000_000_000,
        generation: "recovered-preview-generation",
        persist: () => events.push("persist"),
      },
    );
    expect(events.slice(0, 3)).toEqual([
      "revoke:interrupted-token",
      "persist",
      "mint",
    ]);
    expect(events).toContain("install");
  });
});
