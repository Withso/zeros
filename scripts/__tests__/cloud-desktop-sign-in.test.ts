import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { generateKeyPair, SignJWT } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDesktopSignIn } from "../dev-environment/desktop-sign-in.mjs";
import { desktopEnvironment, publicDevProfile } from "../dev-environment/profile.mjs";
import { ensureWorkspace } from "../dev-environment/state.mjs";
import { bootstrapCloudDesktopSession, verifyCloudDesktopSession } from "../../apps/desktop/electron/cloud-desktop-sign-in";

const roots: string[] = [], servers: Server[] = [], brokers: any[] = [];
afterEach(async () => {
  for (const broker of brokers.splice(0)) await broker.close();
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

async function fixture(password = "fixture-password") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zeros-cloud-desktop-")); roots.push(root);
  const workspace = ensureWorkspace({ repositoryRoot: root, homeDir: root, env: {} });
  const profile = { version: 1, cloudflare: { domain: "example.test", accountId: "a".repeat(32), zoneId: "b".repeat(32), apiToken: "fixture-cloudflare-value" }, workos: {
    environment: "alpha", desktopClientId: "client_desktop", webClientId: "client_web", apiKey: "fixture-api-secret" },
    fixture: { workosUserId: "user_fixture", workosOrganizationId: "org_fixture", expectedEmail: "fixture@example.test" } };
  const desktopEnv = desktopEnvironment(workspace, profile);
  const pub = publicDevProfile(workspace, profile);
  const config = { clientId: pub.desktopClientId, issuer: pub.issuer, audience: pub.audience, jwksUrl: pub.jwksUrl };
  const keys = await generateKeyPair("RS256");
  const claims = { sub: profile.fixture.workosUserId, sid: "session_fixture", jti: "token_fixture", client_id: config.clientId,
    org_id: profile.fixture.workosOrganizationId, "https://zeros.build/email": profile.fixture.expectedEmail,
    "https://zeros.build/email_verified": true };
  const mint = (extra = {}, key = keys.privateKey) => new SignJWT({ iss: config.issuer, aud: config.audience, ...claims, ...extra }).setProtectedHeader({ alg: "RS256" })
    .setIssuedAt().setExpirationTime("5m").sign(key);
  const accessToken = await mint(), refreshToken = "fixture-private-refresh-token";
  const request = vi.fn(async (url: string, init: RequestInit) => {
    if (url.endsWith("sessions/revoke")) return new Response(null, { status: 204 });
    const input = JSON.parse(String(init.body));
    if (input.grant_type === "password") return Response.json({ code: "organization_selection_required",
      pending_authentication_token: "fixture-pending-selection", user: { id: claims.sub, email: profile.fixture.expectedEmail },
      organizations: [{ id: "org_other" }, { id: claims.org_id }] }, { status: 403 });
    return Response.json({ access_token: accessToken, refresh_token: refreshToken, organization_id: claims.org_id,
      authentication_method: "Password", user: { id: claims.sub, email: profile.fixture.expectedEmail, email_verified: true } });
  });
  const server = createServer((req, res) => { void broker.handle(req, res).then((handled: boolean) => {
    if (!handled) res.writeHead(404).end();
  }); });
  servers.push(server); server.listen(0, "127.0.0.1"); await once(server, "listening");
  const broker = createDesktopSignIn(workspace, profile, { port: (server.address() as any).port, runId: "11111111-1111-4111-8111-111111111111",
    root, agentEnv: { ZEROS_DEV_PASSWORD: password }, request }); brokers.push(broker);
  const env = { ...desktopEnv, ...broker.environment };
  const options = { isPackaged: false, localDevelopment: false, env, dataDirectory: desktopEnv.ZEROS_DATA_DIR,
    getSession: vi.fn(async () => null as any), getStoredUser: vi.fn(() => null as any),
    verify: (tokens: any, descriptor: any) => verifyCloudDesktopSession(tokens, descriptor, config, keys.publicKey),
    resolveAccountId: vi.fn(async () => "11111111-1111-4111-8111-111111111112"), persistSession: vi.fn(), request: fetch };
  return { root, workspace, profile, broker, options, request, accessToken, refreshToken, mint, keys, config, claims };
}

describe("electron:cloud private desktop sign-in", () => {
  it("signs in the fixture with the desktop client and selected org before persisting, via consumed 0600 files only", async () => {
    const f = await fixture();
    const file = f.broker.environment.ZEROS_CLOUD_DESKTOP_HANDOFF;
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.stringify(f.options.env)).not.toMatch(/fixture-password|fixture-api-secret|fixture-private-refresh-token/);
    await expect(bootstrapCloudDesktopSession(f.options)).resolves.toBe("signed-in");
    expect(f.options.persistSession).toHaveBeenCalledWith(expect.objectContaining({ providerSubject: "user_fixture", clientKind: "desktop",
      accessToken: f.accessToken, refreshToken: f.refreshToken, accountId: "11111111-1111-4111-8111-111111111112" }));
    const calls = f.request.mock.calls.map(([, init]) => JSON.parse(String(init.body)));
    expect(calls).toEqual([expect.objectContaining({ grant_type: "password", client_id: "client_desktop" }),
      expect.objectContaining({ grant_type: "urn:workos:oauth:grant-type:organization-selection", organization_id: "org_fixture", client_id: "client_desktop" })]);
    expect(fs.existsSync(file)).toBe(false);
    expect(fs.existsSync(path.join(path.dirname(file), "session.json"))).toBe(false);
    await f.broker.close();
    expect(f.request).toHaveBeenCalledTimes(2); // accepted session survives supervisor shutdown
  });

  it("reuses a valid saved fixture session and keeps persistent data paths across launches", async () => {
    const f = await fixture();
    f.options.getSession.mockResolvedValue({ provider: "workos", sub: "user_fixture", email: "fixture@example.test", accessToken: f.accessToken });
    await expect(bootstrapCloudDesktopSession(f.options)).resolves.toBe("existing");
    expect(f.request).not.toHaveBeenCalled(); expect(f.options.persistSession).not.toHaveBeenCalled();
    const restarted = ensureWorkspace({ repositoryRoot: f.root, homeDir: f.root, env: {} });
    expect(desktopEnvironment(restarted, f.profile).ZEROS_DATA_DIR).toBe(f.options.dataDirectory);
  });

  it.each([{ isPackaged: true }, { localDevelopment: true }, { env: { ZEROS_DEV_ENVIRONMENT: "hosted" } }])(
    "keeps packaged, Local Personal/organization-local, and unrelated Dev launches inert: %j", async override => {
      const f = await fixture();
      await expect(bootstrapCloudDesktopSession({ ...f.options, ...override })).resolves.toBe("skipped");
      expect(f.options.getSession).not.toHaveBeenCalled(); expect(f.request).not.toHaveBeenCalled();
    });

  it("does nothing without the optional password and never replaces another stored account", async () => {
    const absent = await fixture("");
    expect(absent.broker.environment).toEqual({});
    await expect(bootstrapCloudDesktopSession(absent.options)).resolves.toBe("skipped");
    const f = await fixture();
    f.options.getStoredUser.mockReturnValue({ provider: "workos", sub: "user_other" });
    await expect(bootstrapCloudDesktopSession(f.options)).rejects.toThrow(/saved session/);
    expect(f.request).not.toHaveBeenCalled(); expect(f.options.persistSession).not.toHaveBeenCalled();
  });

  it.each(["permissions", "symlink", "owner", "expiry"])("refuses a %s handoff before requesting credentials", async problem => {
    const f = await fixture(), file = f.broker.environment.ZEROS_CLOUD_DESKTOP_HANDOFF;
    if (problem === "permissions") fs.chmodSync(file, 0o644);
    else if (problem === "symlink") { fs.renameSync(file, `${file}.original`); fs.symlinkSync(`${file}.original`, file); }
    else { const data = JSON.parse(fs.readFileSync(file, "utf8"));
      if (problem === "owner") data.owner = "b".repeat(24); else data.expiresAt = Date.now() - 1;
      fs.writeFileSync(file, JSON.stringify(data)); }
    await expect(bootstrapCloudDesktopSession(f.options)).rejects.toThrow();
    expect(f.request).not.toHaveBeenCalled(); expect(f.options.persistSession).not.toHaveBeenCalled();
  });

  it("limits a grant to one login, rejects a foreign nonce, and revokes an unconsumed result on cleanup", async () => {
    const f = await fixture(), d = JSON.parse(fs.readFileSync(f.broker.environment.ZEROS_CLOUD_DESKTOP_HANDOFF, "utf8"));
    const url = `http://127.0.0.1:${d.port}/desktop-sign-in`;
    expect((await fetch(url, { method: "POST", headers: { authorization: "Bearer wrong" } })).status).toBe(404);
    const send = () => fetch(url, { method: "POST", headers: { authorization: `Bearer ${d.nonce}` } });
    expect((await send()).status).toBe(204); expect((await send()).status).toBe(409);
    const tokenFile = path.join(path.dirname(f.broker.environment.ZEROS_CLOUD_DESKTOP_HANDOFF), "session.json");
    expect(fs.statSync(tokenFile).mode & 0o777).toBe(0o600);
    await f.broker.close();
    expect(fs.existsSync(tokenFile)).toBe(false);
    expect(f.request.mock.calls.at(-1)?.[0]).toMatch(/sessions\/revoke$/);
  });

  it("verifies signatures, desktop audience/client, fixture subject and org before persistence", async () => {
    const f = await fixture(), d = JSON.parse(fs.readFileSync(f.broker.environment.ZEROS_CLOUD_DESKTOP_HANDOFF, "utf8"));
    const foreignKeys = await generateKeyPair("RS256");
    for (const accessToken of [await f.mint({ client_id: "client_web" }), await f.mint({ sub: "user_other" }),
      await f.mint({ aud: "https://foreign.example.test" }), await f.mint({ iss: "https://foreign.example.test" }),
      await f.mint({ org_id: "org_other" }), await f.mint({}, foreignKeys.privateKey)]) {
      await expect(verifyCloudDesktopSession({ accessToken, refreshToken: f.refreshToken }, d, f.config, f.keys.publicKey)).rejects.toThrow();
    }
  });

  it("removes an abandoned private handoff on the next start, even without a password", async () => {
    const f = await fixture(), file = f.broker.environment.ZEROS_CLOUD_DESKTOP_HANDOFF;
    const next = createDesktopSignIn(f.workspace, f.profile, { port: 23456, runId: "22222222-2222-4222-8222-222222222222",
      root: f.root, agentEnv: {}, request: f.request }); brokers.push(next);
    expect(fs.existsSync(file)).toBe(false); expect(next.environment).toEqual({});
    expect(f.request).not.toHaveBeenCalled();
  });

  it("does not overwrite a session installed while the fixture login is in flight", async () => {
    const f = await fixture();
    f.options.resolveAccountId.mockImplementation(async () => {
      f.options.getStoredUser.mockReturnValue({ provider: "workos", sub: "user_other" });
      return "11111111-1111-4111-8111-111111111112";
    });
    await expect(bootstrapCloudDesktopSession(f.options)).rejects.toThrow(/concurrently/);
    expect(f.options.persistSession).not.toHaveBeenCalled();
  });
});
