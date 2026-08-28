import { describe, expect, it, vi } from "vitest";

import {
  CloudWorkspaceAccessBroker,
  type CloudWorkspaceAccessBrokerApi,
  type CloudWorkspaceTunnelHandle,
} from "../cloud-workspace-access-broker";

const ORGANIZATION_ID = "11111111-1111-4111-8111-111111111111";
const WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";
const GRANT_ID = "33333333-3333-4333-8333-333333333333";
const SECOND_GRANT_ID = "44444444-4444-4444-8444-444444444444";
const NOW = 1_800_000_000_000;
const EXPIRES_AT = new Date(NOW + 30 * 60_000).toISOString();
const SSH_CREDENTIAL = `ssh_${"a".repeat(40)}`;
const PREVIEW_CAPABILITY = `zwp_${"b".repeat(43)}`;

function api(): CloudWorkspaceAccessBrokerApi {
  return {
    issuePreview: vi.fn(async () => ({
      grant: {
        id: GRANT_ID,
        kind: "preview" as const,
        workspaceId: WORKSPACE_ID,
        generation: 7,
        remotePort: 4173,
        expiresAt: EXPIRES_AT,
      },
      preview: {
        logicalUrl: "http://localhost:4173/",
        origin: "https://0123456789abcdef0123456789abcdef.preview.zeros.test",
        capability: PREVIEW_CAPABILITY,
        headerName: "x-zeros-preview-capability" as const,
      },
    })),
    issueSsh: vi.fn(async () => ({
      grant: {
        id: GRANT_ID,
        kind: "ssh" as const,
        workspaceId: WORKSPACE_ID,
        generation: 7,
        remotePort: null,
        expiresAt: EXPIRES_AT,
      },
      ssh: {
        username: SSH_CREDENTIAL,
        host: "ssh.app.daytona.io",
        command: `ssh ${SSH_CREDENTIAL}@ssh.app.daytona.io`,
      },
    })),
    issueTunnel: vi.fn(async () => ({
      grant: {
        id: GRANT_ID,
        kind: "tunnel" as const,
        workspaceId: WORKSPACE_ID,
        generation: 7,
        remotePort: 4173,
        expiresAt: EXPIRES_AT,
      },
      tunnel: {
        sshUsername: SSH_CREDENTIAL,
        sshHost: "ssh.app.daytona.io",
        remoteHost: "127.0.0.1" as const,
        remotePort: 4173,
      },
    })),
    revoke: vi.fn(async () => undefined),
  };
}

function broker(
  accessApi: CloudWorkspaceAccessBrokerApi,
  overrides: Partial<
    ConstructorParameters<typeof CloudWorkspaceAccessBroker>[0]
  > = {},
) {
  return new CloudWorkspaceAccessBroker({
    api: accessApi,
    getAccessToken: vi.fn(async () => "account-access-token"),
    randomId: () => "55555555-5555-4555-8555-555555555555",
    now: () => NOW,
    ...overrides,
  });
}

describe("CloudWorkspaceAccessBroker", () => {
  it("keeps a preview capability in main and returns only safe navigation metadata", async () => {
    const accessApi = api();
    const authorizePreview = vi.fn(() => true);
    const accessBroker = broker(accessApi);

    const result = await accessBroker.openPreview(
      {
        organizationId: ORGANIZATION_ID,
        workspaceId: WORKSPACE_ID,
        port: 4173,
        frameName: "zeros-browser-cloud-1",
      },
      authorizePreview,
    );

    expect(authorizePreview).toHaveBeenCalledWith({
      frameName: "zeros-browser-cloud-1",
      origin: "https://0123456789abcdef0123456789abcdef.preview.zeros.test",
      expiresAt: Date.parse(EXPIRES_AT),
      capability: PREVIEW_CAPABILITY,
    });
    expect(result).toEqual({
      accessId: GRANT_ID,
      logicalUrl: "http://localhost:4173/",
      origin: "https://0123456789abcdef0123456789abcdef.preview.zeros.test",
      admissionUrl:
        "https://0123456789abcdef0123456789abcdef.preview.zeros.test/",
      expiresAt: EXPIRES_AT,
    });
    expect(JSON.stringify(result)).not.toContain(PREVIEW_CAPABILITY);
  });

  it("revokes an unpublished preview when frame-scoped authorization fails", async () => {
    const accessApi = api();
    const accessBroker = broker(accessApi);

    await expect(
      accessBroker.openPreview(
        {
          organizationId: ORGANIZATION_ID,
          workspaceId: WORKSPACE_ID,
          port: 4173,
          frameName: "zeros-browser-cloud-1",
        },
        () => false,
      ),
    ).rejects.toThrow(/frame authorization/i);
    expect(accessApi.revoke).toHaveBeenCalledWith("account-access-token", {
      organizationId: ORGANIZATION_ID,
      workspaceId: WORKSPACE_ID,
      grantId: GRANT_ID,
      credential: PREVIEW_CAPABILITY,
    });
  });

  it("serializes renewal for one Browser frame so a late grant cannot become orphaned", async () => {
    const accessApi = api();
    const firstResponse = await accessApi.issuePreview("", {} as never);
    const secondResponse = {
      ...firstResponse,
      grant: { ...firstResponse.grant, id: SECOND_GRANT_ID },
      preview: {
        ...firstResponse.preview,
        capability: `zwp_${"c".repeat(43)}`,
      },
    };
    let resolveFirst!: (value: typeof firstResponse) => void;
    vi.mocked(accessApi.issuePreview)
      .mockReset()
      .mockImplementationOnce(
        async () =>
          new Promise<typeof firstResponse>((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockResolvedValueOnce(secondResponse);
    const accessBroker = broker(accessApi);
    const target = {
      organizationId: ORGANIZATION_ID,
      workspaceId: WORKSPACE_ID,
      port: 4173,
      frameName: "zeros-browser-cloud-1",
    };

    const first = accessBroker.openPreview(target, () => true);
    await vi.waitFor(() =>
      expect(accessApi.issuePreview).toHaveBeenCalledTimes(1),
    );
    const second = accessBroker.openPreview(target, () => true);
    await Promise.resolve();
    const callsBeforeFirstCompleted = vi.mocked(accessApi.issuePreview).mock
      .calls.length;
    resolveFirst(firstResponse);
    await Promise.all([first, second]);

    expect(callsBeforeFirstCompleted).toBe(1);
    expect(accessApi.revoke).toHaveBeenCalledWith("account-access-token", {
      organizationId: ORGANIZATION_ID,
      workspaceId: WORKSPACE_ID,
      grantId: GRANT_ID,
      credential: PREVIEW_CAPABILITY,
    });
  });

  it("does not let a late duplicate revocation orphan a newer preview for the same frame", async () => {
    const accessApi = api();
    const firstResponse = await accessApi.issuePreview("", {} as never);
    const secondCapability = `zwp_${"c".repeat(43)}`;
    vi.mocked(accessApi.issuePreview)
      .mockReset()
      .mockResolvedValueOnce(firstResponse)
      .mockResolvedValueOnce({
        ...firstResponse,
        grant: { ...firstResponse.grant, id: SECOND_GRANT_ID },
        preview: { ...firstResponse.preview, capability: secondCapability },
      });
    const revokeReleases: Array<() => void> = [];
    vi.mocked(accessApi.revoke).mockImplementation(
      async () =>
        new Promise<void>((resolve) => {
          revokeReleases.push(resolve);
        }),
    );
    const accessBroker = broker(accessApi);
    const target = {
      organizationId: ORGANIZATION_ID,
      workspaceId: WORKSPACE_ID,
      port: 4173,
      frameName: "zeros-browser-cloud-1",
    };
    const first = await accessBroker.openPreview(target, () => true);

    const lateDuplicate = accessBroker.revoke(first.accessId);
    await vi.waitFor(() => expect(revokeReleases).toHaveLength(1));
    const renewal = accessBroker.openPreview(target, () => true);
    await vi.waitFor(() => expect(revokeReleases).toHaveLength(2));
    revokeReleases[1]!();
    const renewed = await renewal;
    expect(renewed.accessId).toBe(SECOND_GRANT_ID);

    revokeReleases[0]!();
    await lateDuplicate;
    const closeFrame = accessBroker.revokePreviewFrame(target.frameName);
    await vi.waitFor(() => expect(revokeReleases).toHaveLength(3));
    revokeReleases[2]!();
    await expect(closeFrame).resolves.toBe(true);
    expect(accessApi.revoke).toHaveBeenLastCalledWith("account-access-token", {
      organizationId: ORGANIZATION_ID,
      workspaceId: WORKSPACE_ID,
      grantId: SECOND_GRANT_ID,
      credential: secondCapability,
    });
  });

  it("copies an SSH command without returning its bearer to renderer code", async () => {
    const accessApi = api();
    const writeClipboard = vi.fn();
    const accessBroker = broker(accessApi, { writeClipboard });

    const result = await accessBroker.copySshCommand({
      organizationId: ORGANIZATION_ID,
      workspaceId: WORKSPACE_ID,
    });

    expect(writeClipboard).toHaveBeenCalledWith(
      `ssh ${SSH_CREDENTIAL}@ssh.app.daytona.io`,
    );
    expect(result).toEqual({ accessId: GRANT_ID, expiresAt: EXPIRES_AT });
    expect(JSON.stringify(result)).not.toContain(SSH_CREDENTIAL);
  });

  it("revokes SSH access when a native Terminal launch fails", async () => {
    const accessApi = api();
    const accessBroker = broker(accessApi, {
      launchTerminal: vi.fn(async () => {
        throw new Error("Terminal unavailable");
      }),
    });

    await expect(
      accessBroker.openSshTerminal({
        organizationId: ORGANIZATION_ID,
        workspaceId: WORKSPACE_ID,
      }),
    ).rejects.toThrow("Terminal unavailable");
    expect(accessApi.revoke).toHaveBeenCalledWith("account-access-token", {
      organizationId: ORGANIZATION_ID,
      workspaceId: WORKSPACE_ID,
      grantId: GRANT_ID,
      credential: SSH_CREDENTIAL,
    });
  });

  it("starts only a structured localhost tunnel and stops it before revocation", async () => {
    const accessApi = api();
    const order: string[] = [];
    const handle: CloudWorkspaceTunnelHandle = {
      localPort: 54173,
      stop: vi.fn(async () => {
        order.push("stop");
      }),
    };
    const startTunnel = vi.fn(async () => handle);
    vi.mocked(accessApi.revoke).mockImplementation(async () => {
      order.push("revoke");
    });
    const accessBroker = broker(accessApi, { startTunnel });

    const opened = await accessBroker.startTunnel({
      organizationId: ORGANIZATION_ID,
      workspaceId: WORKSPACE_ID,
      remotePort: 4173,
      localPort: 54173,
    });
    expect(startTunnel).toHaveBeenCalledWith({
      localHost: "127.0.0.1",
      localPort: 54173,
      remoteHost: "127.0.0.1",
      remotePort: 4173,
      sshUsername: SSH_CREDENTIAL,
      sshHost: "ssh.app.daytona.io",
      expiresAt: EXPIRES_AT,
    });
    expect(opened).toEqual({
      accessId: GRANT_ID,
      localHost: "127.0.0.1",
      localPort: 54173,
      remotePort: 4173,
      expiresAt: EXPIRES_AT,
    });

    await accessBroker.revoke(GRANT_ID);
    expect(order).toEqual(["stop", "revoke"]);
  });

  it("still revokes provider authority when local tunnel cleanup fails", async () => {
    const accessApi = api();
    const handle: CloudWorkspaceTunnelHandle = {
      localPort: 54173,
      stop: vi.fn(async () => {
        throw new Error("local tunnel cleanup failed");
      }),
    };
    const accessBroker = broker(accessApi, {
      startTunnel: vi.fn(async () => handle),
    });
    const opened = await accessBroker.startTunnel({
      organizationId: ORGANIZATION_ID,
      workspaceId: WORKSPACE_ID,
      remotePort: 4173,
      localPort: 54173,
    });

    await expect(accessBroker.revoke(opened.accessId)).rejects.toThrow(
      "local tunnel cleanup failed",
    );

    expect(accessApi.revoke).toHaveBeenCalledWith("account-access-token", {
      organizationId: ORGANIZATION_ID,
      workspaceId: WORKSPACE_ID,
      grantId: GRANT_ID,
      credential: SSH_CREDENTIAL,
    });
  });

  it("requires a current main-process account session before issuing", async () => {
    const accessApi = api();
    const accessBroker = broker(accessApi, {
      getAccessToken: vi.fn(async () => null),
    });

    await expect(
      accessBroker.copySshCommand({
        organizationId: ORGANIZATION_ID,
        workspaceId: WORKSPACE_ID,
      }),
    ).rejects.toMatchObject({ code: "signed_out" });
    expect(accessApi.issueSsh).not.toHaveBeenCalled();
  });

  it("reserves local capacity before concurrent provider requests can overrun it", async () => {
    const accessApi = api();
    const response = await accessApi.issueSsh("", {} as never);
    const releases: Array<() => void> = [];
    vi.mocked(accessApi.issueSsh)
      .mockReset()
      .mockImplementation(async () => {
        if (releases.length >= 64) return response;
        return new Promise<typeof response>((resolve) => {
          releases.push(() => resolve(response));
        });
      });
    const accessBroker = broker(accessApi, { writeClipboard: vi.fn() });

    const openings = Array.from({ length: 64 }, () =>
      accessBroker.copySshCommand({
        organizationId: ORGANIZATION_ID,
        workspaceId: WORKSPACE_ID,
      }),
    );
    await vi.waitFor(() =>
      expect(accessApi.issueSsh).toHaveBeenCalledTimes(64),
    );

    const overflow = accessBroker
      .copySshCommand({
        organizationId: ORGANIZATION_ID,
        workspaceId: WORKSPACE_ID,
      })
      .then(
        () => ({ error: null }),
        (error: unknown) => ({ error }),
      );
    const overflowResult = await overflow;

    for (const release of releases) release();
    await Promise.all(openings);
    expect(overflowResult.error).toMatchObject({
      code: "cloud_access_local_limit",
    });
    expect(accessApi.issueSsh).toHaveBeenCalledTimes(64);
  });

  it("revokes an SSH issue that resolves after broker disposal without launching", async () => {
    const accessApi = api();
    const issued = await accessApi.issueSsh("", {} as never);
    let resolveIssue!: (value: typeof issued) => void;
    vi.mocked(accessApi.issueSsh)
      .mockReset()
      .mockImplementation(
        async () =>
          new Promise<typeof issued>((resolve) => {
            resolveIssue = resolve;
          }),
      );
    const launchTerminal = vi.fn(async () => undefined);
    const accessBroker = broker(accessApi, { launchTerminal });

    const opening = accessBroker.openSshTerminal({
      organizationId: ORGANIZATION_ID,
      workspaceId: WORKSPACE_ID,
    });
    await vi.waitFor(() => expect(accessApi.issueSsh).toHaveBeenCalledOnce());
    await accessBroker.dispose();
    resolveIssue(issued);

    await expect(opening).rejects.toMatchObject({ code: "signed_out" });
    expect(launchTerminal).not.toHaveBeenCalled();
    expect(accessApi.revoke).toHaveBeenCalledWith("account-access-token", {
      organizationId: ORGANIZATION_ID,
      workspaceId: WORKSPACE_ID,
      grantId: GRANT_ID,
      credential: SSH_CREDENTIAL,
    });
  });

  it("rolls back frame authorization when disposal races preview publication", async () => {
    const accessApi = api();
    const accessBroker = broker(accessApi);
    const revokeFrameAuthorization = vi.fn();

    const opening = accessBroker.openPreview(
      {
        organizationId: ORGANIZATION_ID,
        workspaceId: WORKSPACE_ID,
        port: 4173,
        frameName: "zeros-browser-cloud-1",
      },
      () => {
        void accessBroker.dispose();
        return revokeFrameAuthorization;
      },
    );

    await expect(opening).rejects.toMatchObject({ code: "signed_out" });
    expect(revokeFrameAuthorization).toHaveBeenCalledOnce();
    expect(accessApi.revoke).toHaveBeenCalledWith("account-access-token", {
      organizationId: ORGANIZATION_ID,
      workspaceId: WORKSPACE_ID,
      grantId: GRANT_ID,
      credential: PREVIEW_CAPABILITY,
    });
  });

  it("treats provider-wide SSH revocation as invalidating sibling SSH sessions", async () => {
    const accessApi = api();
    const firstResponse = await accessApi.issueSsh("", {} as never);
    vi.mocked(accessApi.issueSsh)
      .mockReset()
      .mockResolvedValueOnce(firstResponse)
      .mockResolvedValueOnce({
        ...firstResponse,
        grant: {
          ...firstResponse.grant,
          id: SECOND_GRANT_ID,
        },
      });
    const accessBroker = broker(accessApi, { writeClipboard: vi.fn() });
    const first = await accessBroker.copySshCommand({
      organizationId: ORGANIZATION_ID,
      workspaceId: WORKSPACE_ID,
    });
    const second = await accessBroker.copySshCommand({
      organizationId: ORGANIZATION_ID,
      workspaceId: WORKSPACE_ID,
    });

    await accessBroker.revoke(first.accessId);
    await expect(accessBroker.revoke(second.accessId)).resolves.toBe(false);
  });

  it("does not invalidate SSH access issued for a newer workspace generation", async () => {
    const accessApi = api();
    const firstResponse = await accessApi.issueSsh("", {} as never);
    vi.mocked(accessApi.issueSsh)
      .mockReset()
      .mockResolvedValueOnce(firstResponse)
      .mockResolvedValueOnce({
        ...firstResponse,
        grant: {
          ...firstResponse.grant,
          id: SECOND_GRANT_ID,
          generation: firstResponse.grant.generation + 1,
        },
      });
    const accessBroker = broker(accessApi, { writeClipboard: vi.fn() });
    const first = await accessBroker.copySshCommand({
      organizationId: ORGANIZATION_ID,
      workspaceId: WORKSPACE_ID,
    });
    const second = await accessBroker.copySshCommand({
      organizationId: ORGANIZATION_ID,
      workspaceId: WORKSPACE_ID,
    });

    await accessBroker.revoke(first.accessId);
    await expect(accessBroker.revoke(second.accessId)).resolves.toBe(true);
    expect(accessApi.revoke).toHaveBeenCalledTimes(2);
  });

  it("coalesces provider-wide SSH revocation while disposing sibling access", async () => {
    const accessApi = api();
    const tunnelResponse = await accessApi.issueTunnel("", {} as never);
    vi.mocked(accessApi.issueTunnel)
      .mockReset()
      .mockResolvedValue({
        ...tunnelResponse,
        grant: { ...tunnelResponse.grant, id: SECOND_GRANT_ID },
      });
    const tunnel: CloudWorkspaceTunnelHandle = {
      localPort: 54173,
      stop: vi.fn(async () => undefined),
    };
    const disposeLocalAccess = vi.fn(async () => undefined);
    const accessBroker = broker(accessApi, {
      writeClipboard: vi.fn(),
      startTunnel: vi.fn(async () => tunnel),
      disposeLocalAccess,
    });
    await accessBroker.copySshCommand({
      organizationId: ORGANIZATION_ID,
      workspaceId: WORKSPACE_ID,
    });
    await accessBroker.startTunnel({
      organizationId: ORGANIZATION_ID,
      workspaceId: WORKSPACE_ID,
      remotePort: 4173,
      localPort: 54173,
    });

    await accessBroker.dispose();

    expect(tunnel.stop).toHaveBeenCalledOnce();
    expect(disposeLocalAccess).toHaveBeenCalledOnce();
    expect(accessApi.revoke).toHaveBeenCalledOnce();
  });

  it("uses the captured issuing account token to revoke after sign-out", async () => {
    const accessApi = api();
    const getAccessToken = vi
      .fn<() => Promise<string | null>>()
      .mockResolvedValueOnce("issuing-account-token")
      .mockResolvedValue(null);
    const accessBroker = broker(accessApi, {
      getAccessToken,
      writeClipboard: vi.fn(),
    });
    await accessBroker.copySshCommand({
      organizationId: ORGANIZATION_ID,
      workspaceId: WORKSPACE_ID,
    });

    await accessBroker.dispose();

    expect(accessApi.revoke).toHaveBeenCalledWith(
      "issuing-account-token",
      expect.objectContaining({
        grantId: GRANT_ID,
        credential: SSH_CREDENTIAL,
      }),
    );
  });
});
