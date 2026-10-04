import { describe, expect, it, vi } from "vitest";
import { CloudRuntimeServiceClient } from "../cloud-runtime-service-client";

const organizationId = "11111111-1111-4111-8111-111111111111";
const workspaceId = "22222222-2222-4222-8222-222222222222";
const grantId = "33333333-3333-4333-8333-333333333333";
const deviceId = "44444444-4444-4444-8444-444444444444";
const now = 1_800_000_000_000;
const proof = {
  deviceId,
  keyVersion: 3,
  timestampMs: now,
  nonce: "n".repeat(32),
  signature: "s".repeat(86),
};
const request = {
  organizationId,
  workspaceId,
  kind: "ssh" as const,
  expiresInMinutes: 15,
  idempotencyKey: "desktop:ssh:fixture",
};
function document(kind: "ssh" | "tunnel" = "ssh") {
  return {
    grant: {
      id: grantId,
      workspaceId,
      generation: 7,
      deviceId,
      kind,
      remotePort: kind === "ssh" ? null : 4173,
      expiresAt: new Date(now + 15 * 60_000).toISOString(),
    },
    transport: {
      version: 1,
      url: `wss://api.zeros.test/v1/cloud-workspaces/services/${kind}/${grantId}`,
      capability: `zsh_${"a".repeat(43)}`,
      headerName: "x-zeros-runtime-service",
      protocol: "zeros.service.v1",
    },
    ...(kind === "ssh"
      ? { ssh: { username: "zeros", hostKey: "stream-introduction" } }
      : {}),
  };
}
function fixture(body: unknown = document()) {
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(new Response(JSON.stringify(body), { status: 201 }))
    .mockResolvedValue(new Response(null, { status: 204 }));
  const sign = vi.fn(async () => proof);
  return {
    fetch,
    sign,
    client: new CloudRuntimeServiceClient({
      baseUrl: "https://api.zeros.test",
      fetch,
      sign,
      now: () => now,
    }),
  };
}

describe("native runtime service admission", () => {
  it("signs the exact native action payload and keeps its capability out of the URL", async () => {
    const { client, fetch, sign } = fixture();
    const access = await client.issue("account-access-token", request);
    expect(sign).toHaveBeenCalledWith("account-access-token", {
      ...request,
      remotePort: null,
    });
    expect(access.grant).toEqual(document().grant);
    expect(fetch).toHaveBeenCalledWith(
      `https://api.zeros.test/v1/organizations/${organizationId}/cloud-workspaces/${workspaceId}/runtime/services`,
      expect.objectContaining({
        method: "POST",
        redirect: "error",
        credentials: "omit",
        body: JSON.stringify({ kind: "ssh", expiresInMinutes: 15 }),
        headers: expect.objectContaining({
          "x-zeros-device-id": deviceId,
          "x-zeros-device-key-version": "3",
          "x-zeros-device-signature": proof.signature,
          "idempotency-key": request.idempotencyKey,
        }),
      }),
    );
    expect(
      String(fetch.mock.calls[0]![0]).includes(access.transport.capability),
    ).toBe(false);
  });

  it.each([
    "wrong-device",
    "wrong-workspace",
    "wrong-kind",
    "expired",
    "long-expiry",
    "wrong-username",
    "extra-field",
  ])("rejects and retires a published %s grant", async (variant) => {
    const body = document();
    if (variant === "wrong-device") body.grant.deviceId = organizationId;
    if (variant === "wrong-workspace") body.grant.workspaceId = organizationId;
    if (variant === "wrong-kind") body.grant.kind = "tunnel";
    if (variant === "expired")
      body.grant.expiresAt = new Date(now).toISOString();
    if (variant === "long-expiry")
      body.grant.expiresAt = new Date(now + 32 * 60_000).toISOString();
    if (variant === "wrong-username") body.ssh!.username = "root";
    if (variant === "extra-field")
      Object.assign(body.transport, { adminKey: "untrusted" });
    const { client, fetch } = fixture(body);
    await expect(
      client.issue("account-access-token", request),
    ).rejects.toMatchObject({ code: "bad_response" });
    expect(fetch.mock.calls[1]?.[0]).toBe(
      `https://api.zeros.test/v1/organizations/${organizationId}/cloud-workspaces/${workspaceId}/runtime/services/${grantId}`,
    );
  });

  it.each([
    `wss://attacker.test/v1/cloud-workspaces/services/ssh/${grantId}`,
    `ws://api.zeros.test/v1/cloud-workspaces/services/ssh/${grantId}`,
    `wss://api.zeros.test/v1/cloud-workspaces/services/tunnel/${grantId}`,
    `wss://api.zeros.test/v1/cloud-workspaces/services/ssh/${workspaceId}`,
    `wss://api.zeros.test/v1/cloud-workspaces/services/ssh/${grantId}?token=hidden`,
    `wss://user:password@api.zeros.test/v1/cloud-workspaces/services/ssh/${grantId}`,
  ])(
    "rejects a transport outside the exact control-plane service URL",
    async (url) => {
      const body = document();
      body.transport.url = url;
      const { client } = fixture(body);
      await expect(
        client.issue("account-access-token", request),
      ).rejects.toMatchObject({ code: "bad_response" });
    },
  );

  it("binds TCP to the requested port and device proof", async () => {
    const { client, sign } = fixture(document("tunnel"));
    const access = await client.issue("account-access-token", {
      ...request,
      kind: "tunnel",
      remotePort: 4173,
    });
    expect(access.grant.remotePort).toBe(4173);
    expect(sign).toHaveBeenCalledWith("account-access-token", {
      ...request,
      kind: "tunnel",
      remotePort: 4173,
    });
    const mismatch = fixture(document("tunnel"));
    await expect(
      mismatch.client.issue("account-access-token", {
        ...request,
        kind: "tunnel",
        remotePort: 4174,
      }),
    ).rejects.toMatchObject({ code: "bad_response" });
  });

  it.each([22, 1023, 22222, 39393, 65536, 4173.5])(
    "rejects reserved or invalid remote port %s before signing",
    async (remotePort) => {
      const { client, sign, fetch } = fixture();
      await expect(
        client.issue("account-access-token", {
          ...request,
          kind: "tunnel",
          remotePort,
        }),
      ).rejects.toThrow();
      expect(sign).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("never reflects a response, network exception or unknown error code", async () => {
    const { client, fetch } = fixture();
    fetch
      .mockReset()
      .mockResolvedValue(
        new Response(
          JSON.stringify({
            error: { code: "untrusted-code", message: "untrusted-message" },
          }),
          { status: 403 },
        ),
      );
    await expect(
      client.issue("account-access-token", request),
    ).rejects.toMatchObject({ code: "request_failed" });
    fetch.mockRejectedValue(new Error("untrusted-message"));
    await expect(
      client.issue("account-access-token", request),
    ).rejects.toMatchObject({ code: "control_plane_unavailable" });
  });

  it("revokes only the exact native grant without a provider credential or device proof", async () => {
    const { client, fetch, sign } = fixture();
    fetch.mockReset().mockResolvedValue(new Response(null, { status: 204 }));
    await client.revoke("account-access-token", {
      organizationId,
      workspaceId,
      grantId,
    });
    expect(sign).not.toHaveBeenCalled();
    const options = fetch.mock.calls[0]![1]!;
    expect(options.method).toBe("DELETE");
    expect(Object.keys(options.headers!)).not.toContain(
      "x-zeros-access-credential",
    );
  });
});
