import { randomBytes, randomUUID } from "node:crypto";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import type { WorkOS } from "@workos-inc/node";
import { describe, expect, it, vi } from "vitest";
import { workosMemberVerifier } from "./authentication.js";
import { devConnectionsEnabled, loadDevConnectionsConfig } from "./config.js";
import { openMaterial, sealMaterial } from "./envelope.js";
import { DevConnectionClient } from "./client.js";
import { createDevConnectionsRoutes } from "./routes.js";
import { GithubMaterialSchema, GrantSchema, parseMaterial } from "./types.js";
import { boundedJson } from "./http.js";

const keys = {
  currentKeyVersion: 1,
  keys: { 1: randomBytes(32).toString("base64url") },
};
const binding = {
  id: randomUUID(),
  memberId: randomUUID(),
  revision: 1,
  version: 1,
  keyVersion: 1,
  kind: "claude-api-key",
  accountId: "member-account",
  appScope: "api",
};
const material = {
  kind: "claude-api-key" as const,
  apiKey: "synthetic-api-key-for-unit-tests",
};
describe("Dev connections contracts", () => {
  it("refuses renewal material or mismatched scope in backend grant responses", async () => {
    const scope = {
        action: "agent" as const,
        workspaceId: randomUUID(),
        model: "test-model",
      },
      bindingId = randomUUID();
    const base = {
      id: randomUUID(),
      bindingId,
      audience: "zeros-dev-connections-v1",
      scope,
      expiresAt: new Date(Date.now() + 60000).toISOString(),
      providerExpiresAt: null,
      material,
    };
    expect(
      GrantSchema.safeParse({
        ...base,
        material: {
          kind: "codex-chatgpt",
          accountId: "account",
          accessToken: "synthetic-access-token",
          refreshToken: "synthetic-refresh-token",
          expiresAt: 1900000000,
        },
      }).success,
    ).toBe(false);
    const client = new DevConnectionClient(
      {
        deployment: "dev",
        enabled: true,
        origin: "https://connections.example.test",
        generation: {
          id: randomUUID(),
          credential: randomBytes(32).toString("base64url"),
          audience: "zeros-dev-connections-v1",
        },
      },
      async () => Response.json({ ...base, bindingId: randomUUID() }),
    );
    await expect(
      client.grant("synthetic-member-token", bindingId, scope),
    ).rejects.toThrow("grant mismatch");
  });
  it("bounds streamed provider responses even without a Content-Length header", async () => {
    let cancelled = false;
    const body = new ReadableStream({
      pull(controller) {
        controller.enqueue(new Uint8Array(65536));
      },
      cancel() {
        cancelled = true;
      },
    });
    await expect(boundedJson(new Response(body), 100000)).rejects.toThrow(
      "Dev connection response unavailable",
    );
    expect(cancelled).toBe(true);
  });
  it("uses an authenticated envelope bound to owner, kind, version and app", () => {
    const envelope = sealMaterial(material, binding, keys);
    expect(openMaterial(envelope, binding, keys)).toEqual(material);
    for (const change of [
      { memberId: randomUUID() },
      { version: 2 },
      { revision: 2 },
      { kind: "cursor-api-key" },
      { accountId: "another-account" },
      { appScope: "another-app" },
    ])
      expect(() =>
        openMaterial(envelope, { ...binding, ...change }, keys),
      ).toThrow();
    expect(() =>
      openMaterial(
        { ...envelope, ciphertext: Buffer.from("corrupted") },
        binding,
        keys,
      ),
    ).toThrow();
  });
  it("does not accept a Codex access/refresh pair instead of native cache", () => {
    expect(() =>
      parseMaterial({
        kind: "codex-chatgpt",
        accessToken: "synthetic-access-token",
        refreshToken: "synthetic-refresh-token",
        accountId: "account",
        expiresAt: 1900000000,
      }),
    ).toThrow();
  });
  it("is unavailable in every release environment even with a true flag", () => {
    for (const channel of ["alpha", "beta", "production", ""]) {
      const env = {
        ZEROS_DEPLOY_ENV: channel,
        ZEROS_DEV_CONNECTIONS_ENABLED: "true",
      };
      expect(devConnectionsEnabled(env)).toBe(false);
      expect(() => loadDevConnectionsConfig(env)).toThrow(
        "Invalid Dev connections configuration",
      );
    }
    expect(
      devConnectionsEnabled({
        ZEROS_DEPLOY_ENV: "dev",
        ZEROS_DEV_CONNECTIONS_ENABLED: "true",
      }),
    ).toBe(true);
  });
  it("restores only metadata and never sends local identity UUIDs to the broker", async () => {
    const generation = {
        id: randomUUID(),
        credential: randomBytes(32).toString("base64url"),
        audience: "zeros-dev-connections-v1",
      },
      fetcher = vi.fn(async () => Response.json({ connections: [] }));
    const client = new DevConnectionClient(
        {
          deployment: "dev",
          enabled: true,
          origin: "https://connections.example.test",
          generation,
        },
        fetcher,
      ),
      replace = vi.fn();
    const mapping = {
      issuer: "https://identity.example.test",
      subject: "user_member",
      workosOrganizationId: "org_dev",
      localUserId: randomUUID(),
      localOrganizationId: randomUUID(),
    };
    await client.restoreAfterSignIn("synthetic-member-token", mapping, {
      replace,
    });
    expect(replace).toHaveBeenCalledWith(mapping, generation.id, []);
    expect(fetcher.mock.calls[0]?.[1]?.body).toBe("{}");
    expect(fetcher.mock.calls[0]?.[1]?.redirect).toBe("error");
  });
  it("does not replace known local references during a service outage", async () => {
    const client = new DevConnectionClient(
      {
        deployment: "dev",
        enabled: true,
        origin: "https://connections.example.test",
        generation: {
          id: randomUUID(),
          credential: randomBytes(32).toString("base64url"),
          audience: "zeros-dev-connections-v1",
        },
      },
      async () => {
        throw new Error("synthetic-secret-in-provider-error");
      },
    );
    const replace = vi.fn();
    await expect(
      client.restoreAfterSignIn("synthetic-token", {} as any, { replace }),
    ).rejects.toThrow("Dev connections unavailable");
    expect(replace).not.toHaveBeenCalled();
  });
  it("redacts raw server failures and has no product routes", async () => {
    const app = createDevConnectionsRoutes({
      config: {} as any,
      store: {} as any,
      broker: {} as any,
      verifyMember: vi.fn(),
      verifyGithub: vi.fn(),
      ready: async () => {
        throw new Error("synthetic-secret-in-error");
      },
    });
    const response = await app.request("/healthz");
    expect(response.status).toBe(503);
    expect(await response.text()).toBe(
      '{"error":"dev_connection_unavailable"}',
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect((await app.request("/v1/cloud-workspaces")).status).toBe(404);
  });
  it("validates GitHub metadata without allowing a native cache in its envelope", () => {
    expect(
      GithubMaterialSchema.safeParse({
        kind: "github-app",
        accessToken: "synthetic-access-token",
        refreshToken: "synthetic-refresh-token",
        expiresAt: 1900000000,
        refreshExpiresAt: 1910000000,
        accountId: "123",
        appId: "42",
        clientId: "client_dev",
        nativeCache: {},
      }).success,
    ).toBe(false);
  });
});

describe("independent WorkOS member verification", () => {
  const config = {
    issuer: "https://api.workos.com/user_management/client_web",
    audience: "https://api-dev.example.test",
    webClientId: "client_web",
    desktopClientId: "client_desktop",
    jwksUrl: "https://api.workos.com/sso/jwks/client_web",
    apiKey: "synthetic-api-key",
    organization: "org_dev",
  };
  async function fixture() {
    const { publicKey, privateKey } = await generateKeyPair("RS256");
    const jwk = await exportJWK(publicKey);
    jwk.kid = "test";
    const membership = vi.fn(async () => ({
      data: [
        { userId: "user_member", organizationId: "org_dev", status: "active" },
      ],
    }));
    const sessions = vi.fn(async () => ({
      data: [{ id: "session_member", status: "active" }],
    }));
    const client = {
      userManagement: {
        getUser: vi.fn(async () => ({
          id: "user_member",
          emailVerified: true,
        })),
        listOrganizationMemberships: membership,
        listSessions: sessions,
      },
    };
    const verifier = workosMemberVerifier(
      config,
      createLocalJWKSet({ keys: [jwk] }),
      client as unknown as WorkOS,
    );
    const sign = async (changes: Record<string, unknown> = {}) =>
      new SignJWT({
        iss: config.issuer,
        aud: config.audience,
        sub: "user_member",
        sid: "session_member",
        jti: "token_member",
        client_id: "client_desktop",
        "https://zeros.build/email": "member@example.test",
        "https://zeros.build/email_verified": true,
        ...changes,
      })
        .setProtectedHeader({ alg: "RS256", kid: "test" })
        .setIssuedAt()
        .setExpirationTime("5m")
        .sign(privateKey);
    return { verifier, sign, membership, sessions };
  }
  it("requires a signed current session and current organization membership", async () => {
    const f = await fixture(),
      token = await f.sign();
    expect(await f.verifier(token, "org_dev")).toMatchObject({
      issuer: config.issuer,
      subject: "user_member",
      organization: "org_dev",
    });
    f.membership.mockResolvedValue({ data: [] });
    await expect(f.verifier(token, "org_dev")).rejects.toMatchObject({
      status: 403,
    });
  });
  it("rejects issuer, audience, client, subject, organization and expired session substitution", async () => {
    const f = await fixture();
    for (const change of [
      { iss: "https://evil.example.test" },
      { aud: "https://api.zeros.build" },
      { client_id: "client_other" },
      { sub: "user_other" },
    ])
      await expect(
        f.verifier(await f.sign(change), "org_dev"),
      ).rejects.toMatchObject({ status: 403 });
    await expect(f.verifier(await f.sign(), "org_other")).rejects.toMatchObject(
      { status: 403 },
    );
    f.sessions.mockResolvedValue({ data: [] });
    await expect(f.verifier(await f.sign(), "org_dev")).rejects.toMatchObject({
      status: 403,
    });
  });
});
