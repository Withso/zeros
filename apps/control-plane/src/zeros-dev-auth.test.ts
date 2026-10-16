import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { loadConfig, type Config } from "./config.js";
import { createApp } from "./app.js";
import { ZerosDevAuthError } from "./zeros-dev-auth-config.js";
import { createZerosDevAuthRoutes, ZerosDevAuthLimiter } from "./zeros-dev-auth.js";
import type { ZerosDevAuthRepository } from "./zeros-dev-auth-repository.js";
import { ZerosDevWorkOSPasswordProvider, type ZerosDevPasswordProvider } from "./zeros-dev-auth-workos.js";

const identity = { subject: "user_zeros_dev_fixture", accountId: randomUUID(),
  email: "zeros-dev@example.test", organizationId: randomUUID() };
const auth = { provider: "workos" as const, issuer: "https://api.workos.com/user_management/client_web_fixture",
  jwksUrl: "https://api.workos.com/sso/jwks/client_web_fixture", audience: "https://api-alpha.zeros.build",
  webClientId: "client_web_fixture", desktopClientId: "client_desktop_fixture" };
const env = { DATABASE_URL: "postgres://fixture:fixture@localhost/fixture", AUTH_PROVIDER: "workos",
  AUTH_ISSUER: auth.issuer, AUTH_JWKS_URL: auth.jwksUrl, AUTH_AUDIENCE: auth.audience,
  AUTH_WEB_CLIENT_ID: auth.webClientId, AUTH_DESKTOP_CLIENT_ID: auth.desktopClientId,
  APP_ORIGIN: "https://app-alpha.zeros.build", WORKOS_API_KEY: "synthetic-workos-key",
  WORKOS_COOKIE_PASSWORD: "synthetic-cookie-password-1234567890123456",
  WORKOS_WEBHOOK_SECRET: "synthetic-webhook-secret", ZEROS_SELF_HOSTED: "true",
  ZEROS_DEV_AUTH_ENABLED: "true", ZEROS_DEV_AUTH_SUBJECT: identity.subject,
  ZEROS_DEV_AUTH_ACCOUNT_ID: identity.accountId, ZEROS_DEV_AUTH_EMAIL: identity.email,
  ZEROS_DEV_AUTH_ORGANIZATION_ID: identity.organizationId };
const config = () => loadConfig({ ...env, RAILWAY_ENVIRONMENT_NAME: "alpha" });
const request = () => ({ password: "synthetic-test-password", requestId: randomUUID(),
  device: { id: randomUUID(), intent: "register" as const, platform: "linux" as const } });
const post = (app: ReturnType<typeof createZerosDevAuthRoutes>, data: unknown = request(), headers = {}) =>
  app.request("/auth/zeros-dev/session", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(data) });

function fixture(overrides: { config?: Config; timeoutMs?: number } = {}) {
  const events: string[] = [];
  const grant = { accessToken: "synthetic-access", refreshToken: "synthetic-refresh", sessionId: "session_fixture",
    subject: identity.subject, email: identity.email, emailVerified: true, authenticationMethod: "Password" };
  const claims = { providerSubject: identity.subject, sessionId: grant.sessionId, email: identity.email,
    emailVerified: true as const, clientKind: "web" as const, clientId: auth.webClientId,
    tokenId: "token_fixture", displayName: null, avatarUrl: null, authTime: 100, issuedAt: 100, expiresAt: 200 };
  const repository = {
    begin: vi.fn(async () => { events.push("reserved"); }),
    commit: vi.fn(async () => { events.push("audit_commit"); }),
    revoke: vi.fn(async () => { events.push("local_revocation"); }),
    finish: vi.fn(async () => {}),
  } satisfies ZerosDevAuthRepository;
  const provider = {
    issue: vi.fn(async () => { events.push("workos"); return grant; }),
    refresh: vi.fn(async () => grant),
    verifySessionProof: vi.fn(async () => claims),
    verify: vi.fn(async () => claims),
    revoke: vi.fn(async () => { events.push("provider_revocation"); }),
  } satisfies ZerosDevPasswordProvider;
  const app = createZerosDevAuthRoutes(overrides.config ?? config(), { repository, provider,
    ...(overrides.timeoutMs === undefined ? {} : { timeoutMs: overrides.timeoutMs }) });
  return { app, repository, provider, grant, claims, events };
}

function webLifecycle(overrides: { config?: Config; timeoutMs?: number } = {}) {
  const f = fixture(overrides);
  const claims = { ...f.claims, clientKind: "web" as const, clientId: auth.webClientId };
  f.provider.verify.mockResolvedValue(claims as never);
  const refresh = vi.fn(async () => { f.events.push("refresh"); return f.grant; });
  const verifySessionProof = vi.fn(async () => claims);
  Object.assign(f.provider, { refresh, verifySessionProof });
  const send = (kind: "refresh" | "revoke", extra: Record<string, unknown> = {}, headers = {}) => {
    const { password: _password, ...input } = request();
    return f.app.request(`/auth/zeros-dev/${kind}`, { method: "POST", headers: {
      "content-type": "application/json", authorization: "Bearer synthetic-session-proof", ...headers },
      body: JSON.stringify({ ...input, ...(kind === "refresh" ? { refreshToken: "synthetic-refresh" } : {}), ...extra }) });
  };
  return { ...f, refresh, verifySessionProof, send, webClaims: claims };
}

describe("zeros-dev web session lifecycle stays inside its fixed Alpha admission", () => {
  it("refreshes the same audited session with a server-side secret and commits before returning", async () => {
    const f = webLifecycle();
    const response = await f.send("refresh");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ session: { clientKind: "web", sessionId: f.grant.sessionId } });
    expect(f.verifySessionProof).toHaveBeenCalledWith("synthetic-session-proof");
    expect(f.repository.begin).toHaveBeenCalledWith(identity, expect.anything(), expect.any(String), { sessionId: f.grant.sessionId, operation: "refresh" });
    expect(f.refresh).toHaveBeenCalledWith("synthetic-refresh", expect.any(AbortSignal));
    expect(f.repository.commit).toHaveBeenCalledWith(identity, expect.anything(), f.webClaims, "refresh");
    expect(f.events).toEqual(["reserved", "refresh", "audit_commit"]);
    expect(f.provider.issue).not.toHaveBeenCalled();
  });

  it("refuses a session without its zeros-dev issuance receipt before forwarding a refresh", async () => {
    const f = webLifecycle();
    f.repository.begin.mockRejectedValue(new ZerosDevAuthError("denied"));
    expect((await f.send("refresh")).status).toBe(401);
    expect(f.refresh).not.toHaveBeenCalled();
    expect(f.provider.revoke).not.toHaveBeenCalled();
  });

  it.each(["desktop", "foreign", "subject"])("refuses a %s session proof before database/provider work", async kind => {
    const f = webLifecycle();
    f.verifySessionProof.mockResolvedValue({ ...f.webClaims,
      ...(kind === "desktop" ? { clientKind: "desktop", clientId: auth.desktopClientId } : kind === "foreign" ? { clientId: "client_foreign" } : { providerSubject: "user_foreign" }) } as never);
    expect((await f.send("refresh")).status).toBe(401);
    expect(f.refresh).not.toHaveBeenCalled();
    expect(f.repository.begin).not.toHaveBeenCalled();
  });

  it("withholds a refresh and retires the known session if its success audit fails", async () => {
    const f = webLifecycle();
    f.repository.commit.mockRejectedValue(new Error("synthetic audit failure"));
    expect((await f.send("refresh")).status).toBe(503);
    expect(f.repository.revoke).toHaveBeenCalledWith(identity, f.grant.sessionId);
    expect(f.provider.revoke).toHaveBeenCalledWith(f.grant.sessionId, expect.any(AbortSignal));
  });

  it("retires the known session after an unknown refresh outcome without repeating the grant", async () => {
    const f = webLifecycle();
    f.refresh.mockRejectedValue(new ZerosDevAuthError("unavailable"));
    expect((await f.send("refresh")).status).toBe(503);
    expect(f.refresh).toHaveBeenCalledOnce();
    expect(f.repository.revoke).toHaveBeenCalledWith(identity, f.grant.sessionId);
    expect(f.repository.finish).toHaveBeenCalledWith(identity, expect.anything(), { outcome: "unknown_issuance", cleanup: "retired" });
  });

  it("accepts omitted refresh ceremony metadata but cannot continue a challenge", async () => {
    const f = webLifecycle();
    f.grant.authenticationMethod = "";
    expect((await f.send("refresh")).status).toBe(200);
    Object.assign(f.grant, { challengePresent: true });
    expect((await f.send("refresh")).status).toBe(401);
    expect(f.repository.commit).toHaveBeenCalledOnce();
    expect(f.provider.revoke).toHaveBeenCalledOnce();
  });

  it("shares the source budget between login, refresh and revoke even with spoofed forwarded headers", async () => {
    const f = webLifecycle();
    for (let i = 0; i < 4; i++) expect((await post(f.app, request(), { "x-real-ip": "192.0.2.10" })).status).toBe(200);
    expect((await f.send("refresh", {}, { "x-real-ip": "192.0.2.10" })).status).toBe(200);
    expect((await f.send("revoke", {}, { "x-real-ip": "192.0.2.10", "x-forwarded-for": "192.0.2.11" })).status).toBe(429);
    expect(f.provider.revoke).not.toHaveBeenCalled();
  });

  it("retires both known and returned sessions if refresh unexpectedly switches the SID", async () => {
    const f = webLifecycle();
    f.refresh.mockResolvedValue({ ...f.grant, sessionId: "session_foreign" });
    f.provider.verify.mockResolvedValue({ ...f.webClaims, sessionId: "session_foreign" } as never);
    expect((await f.send("refresh")).status).toBe(401);
    expect(f.repository.commit).not.toHaveBeenCalled();
    expect(f.repository.revoke).toHaveBeenCalledWith(identity, f.grant.sessionId);
    expect(f.repository.revoke).toHaveBeenCalledWith(identity, "session_foreign");
  });

  it("revokes only the proved issued session, with a durable tombstone before success", async () => {
    const f = webLifecycle();
    const result = await f.send("revoke");
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual({ revoked: 1 });
    expect(f.repository.begin).toHaveBeenCalledWith(identity, expect.anything(), expect.any(String), { sessionId: f.grant.sessionId, operation: "revoke" });
    expect(f.repository.revoke).toHaveBeenCalledWith(identity, f.grant.sessionId, expect.objectContaining({ requestId: expect.any(String) }));
    expect(f.provider.revoke).toHaveBeenCalledWith(f.grant.sessionId, expect.any(AbortSignal));
    expect(f.provider.issue).not.toHaveBeenCalled();
    expect(f.refresh).not.toHaveBeenCalled();
  });

  it.each(["beta", "production"])("leaves all lifecycle paths unregistered on %s despite stale enablement", async channel => {
    const cfg = loadConfig({ ...env, RAILWAY_ENVIRONMENT_NAME: channel }); cfg.zerosDevAuth = identity;
    const f = webLifecycle({ config: cfg });
    expect((await f.send("refresh")).status).toBe(404);
    expect((await f.send("revoke")).status).toBe(404);
    expect(f.verifySessionProof).not.toHaveBeenCalled();
  });
});

describe("zeros-dev fixed Alpha identity", () => {
  it("returns the verified web client kind instead of relabeling a password grant as desktop", async () => {
    const f = fixture();
    f.provider.verify.mockResolvedValue({ ...f.claims, clientKind: "web", clientId: auth.webClientId } as never);
    const response = await post(f.app);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ session: { clientKind: "web", providerSubject: identity.subject } });
    expect(f.repository.commit).toHaveBeenCalledWith(identity, expect.anything(), expect.objectContaining({ clientKind: "web" }));
  });

  it("requires explicit enablement and ignores stale keys outside Alpha", async () => {
    for (const channel of ["development", "beta", "production", "preview", ""]) {
      const cfg = loadConfig({ ...env, RAILWAY_ENVIRONMENT_NAME: channel });
      expect(cfg.zerosDevAuth).toBeNull();
      const { app, provider, repository } = fixture({ config: cfg });
      expect((await post(app)).status).toBe(404);
      expect(provider.issue).not.toHaveBeenCalled();
      expect(repository.begin).not.toHaveBeenCalled();
    }
    expect(loadConfig({ ...env, RAILWAY_ENVIRONMENT_NAME: "alpha", ZEROS_DEV_AUTH_ENABLED: "false" }).zerosDevAuth).toBeNull();
    expect(config().zerosDevAuth).toEqual(identity);
  });

  it("gates the assembled app before bearer auth and never exposes it on paused channels", async () => {
    for (const channel of ["beta", "production"]) {
      const cfg = loadConfig({ ...env, RAILWAY_ENVIRONMENT_NAME: channel });
      // Even a stale manually supplied option cannot override the authoritative channel.
      cfg.zerosDevAuth = identity;
      const app = createApp(cfg, {} as never, {} as never);
      for (const path of ["session", "refresh", "revoke"])
        expect((await app.request(`/auth/zeros-dev/${path}`, { method: "POST", body: "{}" })).status).toBe(404);
      cfg.databaseMaintenanceMode = true;
      const maintenanceApp = createApp(cfg, {} as never, {} as never);
      for (const path of ["session", "refresh", "revoke"])
        expect((await maintenanceApp.request(`/auth/zeros-dev/${path}`, { method: "POST", body: "{}" })).status).toBe(404);
    }
  });

  it("refuses incomplete, foreign or non-WorkOS configurations without echoing values", () => {
    for (const [key, value] of [["ZEROS_DEV_AUTH_ACCOUNT_ID", "private-invalid"], ["ZEROS_DEV_AUTH_SUBJECT", ""],
      ["ZEROS_DEV_AUTH_EMAIL", "private-invalid"], ["ZEROS_DEV_AUTH_ORGANIZATION_ID", ""]]) {
      expect(() => loadConfig({ ...env, RAILWAY_ENVIRONMENT_NAME: "alpha", [key!]: value })).toThrow("Invalid zeros-dev authentication configuration");
    }
  });

  it("returns only the existing web session after the fixed identity and audit commit", async () => {
    const { app, provider, repository, events } = fixture();
    const input = request();
    const response = await post(app, input);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({ accountId: identity.accountId, organizationId: identity.organizationId,
      session: { accessToken: "synthetic-access", refreshToken: "synthetic-refresh", clientKind: "web",
        providerSubject: identity.subject, authenticationMethod: "Password" } });
    expect(events).toEqual(["reserved", "workos", "audit_commit"]);
    expect(provider.issue).toHaveBeenCalledWith(identity, input.password, expect.any(AbortSignal));
    expect(repository.commit).toHaveBeenCalledOnce();
    expect(repository.revoke).not.toHaveBeenCalled();
  });

  it.each(["email", "subject", "organizationId", "clientId", "role", "redirectUri", "accessToken"])("rejects caller-selected %s before provider or database work", async key => {
    const { app, provider, repository } = fixture();
    expect((await post(app, { ...request(), [key]: "foreign" })).status).toBe(400);
    expect(provider.issue).not.toHaveBeenCalled();
    expect(repository.begin).not.toHaveBeenCalled();
  });

  it("bounds streamed bytes and enforces content type before parsing", async () => {
    const { app, provider } = fixture();
    expect((await post(app, { ...request(), password: "p".repeat(8192) })).status).toBe(400);
    expect((await post(app, request(), { "content-type": "text/plain" })).status).toBe(400);
    expect(provider.issue).not.toHaveBeenCalled();
  });

  it("withholds and revokes the grant when audit commit fails", async () => {
    const { app, provider, repository } = fixture();
    repository.commit.mockRejectedValueOnce(new Error("synthetic private database diagnostic"));
    const response = await post(app);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: { code: "zeros_dev_auth_unavailable" } });
    expect(repository.revoke).toHaveBeenCalledWith(identity, "session_fixture");
    expect(provider.revoke).toHaveBeenCalledWith("session_fixture", expect.any(AbortSignal));
  });

  it.each(["MFA", "email_verification_required", "sso_required", "authentication_policy_denied"])("fails closed for %s without a challenge continuation", async () => {
    const { app, provider, repository } = fixture();
    provider.issue.mockRejectedValueOnce(new ZerosDevAuthError("denied"));
    const response = await post(app);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: { code: "zeros_dev_auth_denied" } });
    expect(repository.commit).not.toHaveBeenCalled();
    expect(repository.finish).toHaveBeenCalledWith(identity,expect.anything(),{outcome:"denied",cleanup:"not_needed"});
  });

  it.each(["providerSubject", "email", "clientKind", "clientId", "sessionId"])("revokes a grant whose verified %s differs", async field => {
    const { app, claims, repository, provider } = fixture();
    Object.assign(claims, { [field]: "foreign" });
    expect((await post(app)).status).toBe(401);
    expect(repository.commit).not.toHaveBeenCalled();
    expect(provider.revoke).toHaveBeenCalledOnce();
  });

  it("denies a non-password grant, an unverified profile, or a rejected JWT", async () => {
    for (const change of [{ authenticationMethod: "SSO" }, { emailVerified: false }]) {
      const { app, grant, repository, provider } = fixture();
      Object.assign(grant, change);
      expect((await post(app)).status).toBe(401);
      expect(repository.commit).not.toHaveBeenCalled();
      expect(provider.revoke).toHaveBeenCalledOnce();
    }
    const { app, provider } = fixture();
    provider.verify.mockRejectedValueOnce(new Error("bad signature"));
    expect((await post(app)).status).toBe(401);
    expect(provider.revoke).toHaveBeenCalledOnce();
  });

  it("has bounded source and global limits, even if clients spoof forwarded headers", async () => {
    const limiter = new ZerosDevAuthLimiter(() => 0);
    for (let i = 0; i < 5; i++) expect(limiter.take("source" )).toBe(true);
    expect(limiter.take("source")).toBe(false);
    for (let i = 0; i < 15; i++) expect(limiter.take(`other-${i}`)).toBe(true);
    expect(limiter.take("next")).toBe(false);
    const { app, repository }=fixture();
    for(let i=0;i<5;i++) expect((await post(app,request(),{"X-Real-IP":"192.0.2.1","X-Forwarded-For":`198.51.100.${i}`})).status).toBe(200);
    expect((await post(app,request(),{"X-Real-IP":"192.0.2.1","X-Forwarded-For":"198.51.100.99","CF-Connecting-IP":"203.0.113.2"})).status).toBe(429);
    expect((await post(app,request(),{"X-Real-IP":"192.0.2.2"})).status).toBe(200);
    expect(repository.begin.mock.calls).toHaveLength(6);
    const unknown=fixture();
    for(let i=0;i<5;i++) expect((await post(unknown.app,request(),{"X-Forwarded-For":`198.51.100.${i}`})).status).toBe(200);
    expect((await post(unknown.app,request(),{"CF-Connecting-IP":"203.0.113.2"})).status).toBe(429);
  });

  it("returns at the deadline and revokes late issuance without an unhandled rejection", async () => {
    const { app, provider, repository, grant } = fixture({ timeoutMs: 15 });
    let release!: (value: typeof grant) => void;
    provider.issue.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const response = await post(app);
    expect(response.status).toBe(503);
    release(grant);
    await vi.waitFor(() => expect(provider.revoke).toHaveBeenCalledOnce());
    expect(repository.commit).not.toHaveBeenCalled();
  });

  it.each(["headers", "body"])("retires a concrete WorkOS grant received after the %s deadline", async stage => {
    const {repository}=fixture();
    const token=[Buffer.from('{"alg":"RS256"}').toString("base64url"),Buffer.from('{"sid":"session_late_fixture"}').toString("base64url"),"synthetic-signature"].join(".");
    const body=JSON.stringify({access_token:token,refresh_token:"synthetic-late-refresh",authentication_method:"Password",user:{id:identity.subject,email:identity.email,email_verified:true}});
    let release!:()=>void;
    const arrived=new Promise<void>(resolve=>{release=resolve;});
    const fetcher=vi.fn<typeof fetch>(async url=>{
      if(String(url).endsWith("/sessions/revoke"))return new Response(null,{status:204});
      if(stage==="headers"){await arrived;return new Response(body);}
      return new Response(new ReadableStream({async start(controller){await arrived;controller.enqueue(new TextEncoder().encode(body));controller.close();}}));
    });
    const cfg=config();if(cfg.auth.provider!=="workos"||!cfg.workos)throw new Error("fixture config");
    const provider=new ZerosDevWorkOSPasswordProvider(cfg.auth,cfg.workos,fetcher);
    const app=createZerosDevAuthRoutes(cfg,{repository,provider,timeoutMs:15});
    const response=await post(app);
    expect(response.status).toBe(503);expect(repository.commit).not.toHaveBeenCalled();
    release();
    await vi.waitFor(()=>expect(repository.revoke).toHaveBeenCalledWith(identity,"session_late_fixture"));
    expect(fetcher.mock.calls.some(([url])=>String(url).endsWith("/sessions/revoke"))).toBe(true);
    await vi.waitFor(()=>expect(repository.finish).toHaveBeenCalledWith(identity,expect.anything(),{outcome:"unavailable",cleanup:"retired"}));
  });

  it("audits transport outcomes with no recoverable SID as unknown issuance", async () => {
    const {app,provider,repository}=fixture();
    provider.issue.mockRejectedValueOnce(new Error("synthetic transport disconnect"));
    expect((await post(app)).status).toBe(503);
    expect(repository.revoke).not.toHaveBeenCalled();
    expect(repository.finish).toHaveBeenCalledWith(identity,expect.anything(),{outcome:"unknown_issuance",cleanup:"unknown"});
  });
});
