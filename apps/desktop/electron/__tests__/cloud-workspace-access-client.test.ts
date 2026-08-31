import { describe, expect, it, vi } from "vitest";

import {
  CloudWorkspaceAccessClient,
  CloudWorkspaceAccessClientError,
} from "../cloud-workspace-access-client";

const ORGANIZATION_ID = "11111111-1111-4111-8111-111111111111";
const WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";
const GRANT_ID = "33333333-3333-4333-8333-333333333333";
const NOW = 1_800_000_000_000;
const SSH_CREDENTIAL = `ssh_${"a".repeat(40)}`;
const PREVIEW_CAPABILITY = `zwp_${"b".repeat(43)}`;
const ENGINE_INSTANCE_ID = "44444444-4444-4444-8444-444444444444";
const ENGINE_GRANT = `zws_${"c".repeat(43)}`;
const DEVICE_ID = "55555555-5555-4555-8555-555555555555";
const TUNNEL_SESSION_ID = "66666666-6666-4666-8666-666666666666";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function grant(kind: "ssh" | "tunnel" | "preview", remotePort: number | null) {
  return {
    id: GRANT_ID,
    kind,
    workspaceId: WORKSPACE_ID,
    generation: 7,
    remotePort,
    expiresAt: new Date(NOW + 30 * 60_000).toISOString(),
  };
}

describe("CloudWorkspaceAccessClient", () => {
  it("issues SSH access with main-owned auth and validates the exact hosted endpoint", async () => {
    const fetchImpl = vi.fn(async () =>
      json(
        {
          grant: grant("ssh", null),
          ssh: {
            username: SSH_CREDENTIAL,
            host: "ssh.app.daytona.io",
            command: `ssh ${SSH_CREDENTIAL}@ssh.app.daytona.io`,
          },
        },
        201,
      ),
    );
    const client = new CloudWorkspaceAccessClient({
      baseUrl: "https://api.zeros.test/",
      fetch: fetchImpl as typeof fetch,
      now: () => NOW,
    });

    await expect(
      client.issueSsh("account-access-token", {
        organizationId: ORGANIZATION_ID,
        workspaceId: WORKSPACE_ID,
        expiresInMinutes: 30,
        idempotencyKey: "desktop:ssh:request-1",
      }),
    ).resolves.toMatchObject({
      grant: { kind: "ssh", workspaceId: WORKSPACE_ID, remotePort: null },
      ssh: { username: SSH_CREDENTIAL, host: "ssh.app.daytona.io" },
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      `https://api.zeros.test/v1/organizations/${ORGANIZATION_ID}/cloud-workspaces/${WORKSPACE_ID}/access/ssh`,
      expect.objectContaining({
        method: "POST",
        redirect: "error",
        headers: expect.objectContaining({
          authorization: "Bearer account-access-token",
          "content-type": "application/json",
          "idempotency-key": "desktop:ssh:request-1",
        }),
        body: JSON.stringify({ expiresInMinutes: 30 }),
      }),
    );
  });

  it("rejects an SSH response that redirects the desktop to an unapproved host", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        json(
          {
            grant: grant("ssh", null),
            ssh: {
              username: SSH_CREDENTIAL,
              host: "ssh.attacker.example",
              command: `ssh ${SSH_CREDENTIAL}@ssh.attacker.example`,
            },
          },
          201,
        ),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const client = new CloudWorkspaceAccessClient({
      baseUrl: "https://api.zeros.test",
      fetch: fetchImpl as typeof fetch,
      now: () => NOW,
    });

    await expect(
      client.issueSsh("account-access-token", {
        organizationId: ORGANIZATION_ID,
        workspaceId: WORKSPACE_ID,
        expiresInMinutes: 30,
        idempotencyKey: "desktop:ssh:request-2",
      }),
    ).rejects.toMatchObject({ code: "bad_response" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[1]?.[0]).toBe(
      `https://api.zeros.test/v1/organizations/${ORGANIZATION_ID}/cloud-workspaces/${WORKSPACE_ID}/access/${GRANT_ID}`,
    );
  });

  it("reclaims a published grant even when its response metadata is inconsistent", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        json(
          {
            grant: {
              ...grant("ssh", null),
              workspaceId: "44444444-4444-4444-8444-444444444444",
            },
            ssh: {
              username: SSH_CREDENTIAL,
              host: "ssh.app.daytona.io",
              command: `ssh ${SSH_CREDENTIAL}@ssh.app.daytona.io`,
            },
          },
          201,
        ),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const client = new CloudWorkspaceAccessClient({
      baseUrl: "https://api.zeros.test",
      fetch: fetchImpl as typeof fetch,
      now: () => NOW,
    });

    await expect(
      client.issueSsh("account-access-token", {
        organizationId: ORGANIZATION_ID,
        workspaceId: WORKSPACE_ID,
        expiresInMinutes: 30,
        idempotencyKey: "desktop:ssh:request-3",
      }),
    ).rejects.toMatchObject({ code: "bad_response" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[1]?.[0]).toBe(
      `https://api.zeros.test/v1/organizations/${ORGANIZATION_ID}/cloud-workspaces/${WORKSPACE_ID}/access/${GRANT_ID}`,
    );
  });

  it("issues an exact localhost tunnel without accepting a server-selected port", async () => {
    const fetchImpl = vi.fn(async () =>
      json(
        {
          grant: grant("tunnel", 4173),
          tunnel: {
            sshUsername: SSH_CREDENTIAL,
            sshHost: "ssh.app.daytona.io",
            remoteHost: "127.0.0.1",
            remotePort: 4173,
            session: {
              id: TUNNEL_SESSION_ID,
              deviceId: DEVICE_ID,
              state: "starting",
            },
          },
        },
        201,
      ),
    );
    const client = new CloudWorkspaceAccessClient({
      baseUrl: "https://api.zeros.test",
      fetch: fetchImpl as typeof fetch,
      now: () => NOW,
    });

    await expect(
      client.issueTunnel("account-access-token", {
        organizationId: ORGANIZATION_ID,
        workspaceId: WORKSPACE_ID,
        remotePort: 4173,
        deviceId: DEVICE_ID,
        requestedLocalPort: 54173,
        expiresInMinutes: 30,
        idempotencyKey: "desktop:tunnel:request-1",
      }),
    ).resolves.toMatchObject({
      grant: { kind: "tunnel", remotePort: 4173 },
      tunnel: { remoteHost: "127.0.0.1", remotePort: 4173 },
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      expect.stringContaining("/access/tunnels"),
      expect.objectContaining({
        body: JSON.stringify({
          remotePort: 4173,
          deviceId: DEVICE_ID,
          requestedLocalPort: 54173,
          expiresInMinutes: 30,
        }),
      }),
    );
  });

  it("activates only the exact device tunnel and observed loopback port", async () => {
    const fetchImpl = vi.fn(async () =>
      json({
        id: TUNNEL_SESSION_ID,
        deviceId: DEVICE_ID,
        state: "active",
        bindAddress: "127.0.0.1",
        observedLocalPort: 54173,
      }),
    );
    const client = new CloudWorkspaceAccessClient({
      baseUrl: "https://api.zeros.test",
      fetch: fetchImpl as typeof fetch,
      now: () => NOW,
    });

    await expect(
      client.activateTunnel("account-access-token", {
        organizationId: ORGANIZATION_ID,
        workspaceId: WORKSPACE_ID,
        sessionId: TUNNEL_SESSION_ID,
        deviceId: DEVICE_ID,
        observedLocalPort: 54173,
      }),
    ).resolves.toMatchObject({ state: "active", observedLocalPort: 54173 });
    expect(fetchImpl).toHaveBeenCalledWith(
      expect.stringContaining(`/access/tunnels/${TUNNEL_SESSION_ID}`),
      expect.objectContaining({ method: "PATCH" }),
    );
  });

  it("accepts only an exact generation-bound engine admission", async () => {
    const fetchImpl = vi.fn(async () =>
      json(
        {
          version: 1,
          audience: "zeros-cloud-workspace-engine-client-admission-v1",
          workspaceId: WORKSPACE_ID,
          organizationId: ORGANIZATION_ID,
          generation: 7,
          authorityEpoch: 11,
          engineInstanceId: ENGINE_INSTANCE_ID,
          remotePort: 47891,
          grantToken: ENGINE_GRANT,
          expiresAt: new Date(NOW + 120_000).toISOString(),
        },
        201,
      ),
    );
    const client = new CloudWorkspaceAccessClient({
      baseUrl: "https://api.zeros.test",
      fetch: fetchImpl as typeof fetch,
      now: () => NOW,
    });

    await expect(
      client.issueEngineAdmission("account-access-token", {
        organizationId: ORGANIZATION_ID,
        workspaceId: WORKSPACE_ID,
      }),
    ).resolves.toMatchObject({
      generation: 7,
      authorityEpoch: 11,
      engineInstanceId: ENGINE_INSTANCE_ID,
      grantToken: ENGINE_GRANT,
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      `https://api.zeros.test/v1/organizations/${ORGANIZATION_ID}/cloud-workspaces/${WORKSPACE_ID}/runtime/admission`,
      expect.objectContaining({
        method: "POST",
        body: "{}",
        headers: expect.objectContaining({
          authorization: "Bearer account-access-token",
        }),
      }),
    );
  });

  it("fails closed on an ambiguous engine-admission response", async () => {
    const client = new CloudWorkspaceAccessClient({
      baseUrl: "https://api.zeros.test",
      fetch: vi.fn(async () =>
        json(
          {
            version: 1,
            audience: "zeros-cloud-workspace-engine-client-admission-v1",
            workspaceId: WORKSPACE_ID,
            organizationId: ORGANIZATION_ID,
            generation: 7,
            authorityEpoch: 11,
            engineInstanceId: ENGINE_INSTANCE_ID,
            remotePort: 47891,
            grantToken: ENGINE_GRANT,
            expiresAt: new Date(NOW + 120_000).toISOString(),
            providerCredential: "must-not-be-accepted",
          },
          201,
        ),
      ) as typeof fetch,
      now: () => NOW,
    });

    await expect(
      client.issueEngineAdmission("account-access-token", {
        organizationId: ORGANIZATION_ID,
        workspaceId: WORKSPACE_ID,
      }),
    ).rejects.toMatchObject({ code: "bad_response" });
  });

  it("issues an isolated preview capability with an exact HTTPS origin", async () => {
    const client = new CloudWorkspaceAccessClient({
      baseUrl: "https://api.zeros.test",
      fetch: vi.fn(async () =>
        json(
          {
            grant: grant("preview", 4173),
            preview: {
              logicalUrl: "http://localhost:4173/",
              origin:
                "https://0123456789abcdef0123456789abcdef.preview.zeros.test",
              capability: PREVIEW_CAPABILITY,
              headerName: "x-zeros-preview-capability",
            },
          },
          201,
        ),
      ) as typeof fetch,
      now: () => NOW,
      allowedPreviewHostSuffixes: ["preview.zeros.test"],
    });

    await expect(
      client.issuePreview("account-access-token", {
        organizationId: ORGANIZATION_ID,
        workspaceId: WORKSPACE_ID,
        port: 4173,
        expiresInMinutes: 30,
        idempotencyKey: "desktop:preview:request-1",
      }),
    ).resolves.toMatchObject({
      preview: {
        origin: "https://0123456789abcdef0123456789abcdef.preview.zeros.test",
        capability: PREVIEW_CAPABILITY,
      },
    });
  });

  it("rejects and reclaims a preview outside the configured DNS boundary", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        json(
          {
            grant: grant("preview", 4173),
            preview: {
              logicalUrl: "http://localhost:4173/",
              origin: "https://0123456789abcdef0123456789abcdef.attacker.test",
              capability: PREVIEW_CAPABILITY,
              headerName: "x-zeros-preview-capability",
            },
          },
          201,
        ),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const client = new CloudWorkspaceAccessClient({
      baseUrl: "https://api.zeros.test",
      fetch: fetchImpl as typeof fetch,
      now: () => NOW,
      allowedPreviewHostSuffixes: ["preview.zeros.test"],
    });

    await expect(
      client.issuePreview("account-access-token", {
        organizationId: ORGANIZATION_ID,
        workspaceId: WORKSPACE_ID,
        port: 4173,
        expiresInMinutes: 30,
        idempotencyKey: "desktop:preview:request-boundary",
      }),
    ).rejects.toMatchObject({ code: "bad_response" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("revokes by sending both account auth and the exact access verifier", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    const client = new CloudWorkspaceAccessClient({
      baseUrl: "https://api.zeros.test",
      fetch: fetchImpl as typeof fetch,
      now: () => NOW,
    });

    await client.revoke("account-access-token", {
      organizationId: ORGANIZATION_ID,
      workspaceId: WORKSPACE_ID,
      grantId: GRANT_ID,
      credential: PREVIEW_CAPABILITY,
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      `https://api.zeros.test/v1/organizations/${ORGANIZATION_ID}/cloud-workspaces/${WORKSPACE_ID}/access/${GRANT_ID}`,
      expect.objectContaining({
        method: "DELETE",
        headers: expect.objectContaining({
          authorization: "Bearer account-access-token",
          "x-zeros-access-credential": PREVIEW_CAPABILITY,
        }),
      }),
    );
  });

  it("maps bounded control-plane errors without reflecting provider secrets", async () => {
    const client = new CloudWorkspaceAccessClient({
      baseUrl: "https://api.zeros.test",
      fetch: vi.fn(async () =>
        json(
          {
            error: {
              code: "cloud_workspace_access_unavailable",
              message: "Provider bearer must-not-surface",
              providerToken: "must-not-surface",
            },
          },
          409,
        ),
      ) as typeof fetch,
      now: () => NOW,
      allowedPreviewHostSuffixes: ["preview.zeros.test"],
    });

    const error = await client
      .issuePreview("account-access-token", {
        organizationId: ORGANIZATION_ID,
        workspaceId: WORKSPACE_ID,
        port: 4173,
        expiresInMinutes: 30,
        idempotencyKey: "desktop:preview:request-2",
      })
      .catch((value: unknown) => value);
    expect(error).toBeInstanceOf(CloudWorkspaceAccessClientError);
    expect(error).toMatchObject({
      status: 409,
      code: "cloud_workspace_access_unavailable",
      message:
        "Cloud workspace access is available only while the workspace is ready",
    });
    expect(JSON.stringify(error)).not.toContain("must-not-surface");
  });

  it("does not reflect an unknown server error code or message", async () => {
    const client = new CloudWorkspaceAccessClient({
      baseUrl: "https://api.zeros.test",
      fetch: vi.fn(async () =>
        json(
          {
            error: {
              code: "provider_bearer_must_not_surface",
              message: "another-provider-secret",
            },
          },
          503,
        ),
      ) as typeof fetch,
      now: () => NOW,
      allowedPreviewHostSuffixes: ["preview.zeros.test"],
    });

    const error = await client
      .issuePreview("account-access-token", {
        organizationId: ORGANIZATION_ID,
        workspaceId: WORKSPACE_ID,
        port: 4173,
        expiresInMinutes: 30,
        idempotencyKey: "desktop:preview:request-3",
      })
      .catch((value: unknown) => value);
    expect(error).toMatchObject({
      status: 503,
      code: "request_failed",
      message: "Cloud workspace access request failed (503)",
    });
    expect(JSON.stringify(error)).not.toContain("provider_bearer");
    expect(JSON.stringify(error)).not.toContain("another-provider-secret");
  });

  it("requires a bare HTTPS control-plane origin, with loopback only by explicit opt-in", () => {
    expect(
      () =>
        new CloudWorkspaceAccessClient({ baseUrl: "http://api.zeros.test" }),
    ).toThrow(/HTTPS/);
    expect(
      () =>
        new CloudWorkspaceAccessClient({
          baseUrl: "https://api.zeros.test/prefix",
        }),
    ).toThrow(/origin/);
    expect(
      () =>
        new CloudWorkspaceAccessClient({
          baseUrl: "http://127.0.0.1:8788",
          allowInsecureLoopback: true,
        }),
    ).not.toThrow();
  });

  it("does not issue preview access without an exact configured DNS boundary", async () => {
    const fetchImpl = vi.fn();
    const client = new CloudWorkspaceAccessClient({
      baseUrl: "https://api.zeros.test",
      fetch: fetchImpl as typeof fetch,
      now: () => NOW,
    });

    await expect(
      client.issuePreview("account-access-token", {
        organizationId: ORGANIZATION_ID,
        workspaceId: WORKSPACE_ID,
        port: 4173,
        expiresInMinutes: 30,
        idempotencyKey: "desktop:preview:request-unconfigured",
      }),
    ).rejects.toMatchObject({ code: "cloud_preview_not_configured" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
