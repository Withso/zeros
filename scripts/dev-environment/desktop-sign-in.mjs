import fs from "node:fs";
import path from "node:path";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { parseEnv } from "node:util";
import { privateDirectory, writePrivateJson } from "./state.mjs";

const identifier = /^[A-Za-z0-9_-]{1,512}$/;
const failure = () => new Error("Automatic desktop sign-in failed; sign in manually or check the private fixture settings");

/** A per-launch, one-use broker. Only its private descriptor path reaches the
 * desktop environment. Password/API authority stays here; tokens cross in a
 * 0600 file, never in HTTP responses, argv, environment or diagnostics. */
export function createDesktopSignIn(workspace, profile, { port, runId, root, agentEnv, request = fetch }) {
  // The launcher holds this instance's run lock. Recover leftover private
  // handoffs after a crash; a consumed session lives only in Electron's store.
  const handoffs = privateDirectory(workspace.directory, "desktop-sign-in");
  for (const name of fs.readdirSync(handoffs)) {
    if (!/^[a-f0-9-]{36}$/.test(name)) throw failure();
    const previous = privateDirectory(handoffs, name);
    fs.rmSync(previous, { recursive: true });
  }
  let env = agentEnv;
  if (!env) {
    try { env = parseEnv(fs.readFileSync(path.join(root, ".env.agent"), "utf8")); }
    catch (error) { if (error.code !== "ENOENT") throw failure(); }
  }
  if (!env?.ZEROS_DEV_PASSWORD) return { environment: {}, handle: async () => false, close: async () => {} };
  const fixture = profile.fixture;
  if (!identifier.test(fixture?.workosUserId ?? "") || !identifier.test(fixture?.workosOrganizationId ?? "") ||
      !fixture.expectedEmail || !/^client_/.test(profile.workos?.desktopClientId ?? "") ||
      !/^[a-f0-9-]{36}$/.test(runId) || !Number.isInteger(port) || port < 1024 || port > 65535) throw failure();
  const directory = privateDirectory(handoffs, runId);
  const descriptor = { version: 1, owner: workspace.state.owner, runId, port,
    nonce: randomBytes(32).toString("base64url"), expiresAt: Date.now() + 10 * 60_000,
    subject: fixture.workosUserId, organizationId: fixture.workosOrganizationId,
    email: fixture.expectedEmail, desktopClientId: profile.workos.desktopClientId };
  const file = path.join(directory, "request.json");
  writePrivateJson(file, descriptor, { create: true });
  let used = false, accepted = false, closed = false, sid, flight, closing;
  const api = async (route, body, revoke = false) => {
    try {
      const response = await request(`https://api.workos.com/user_management/${route}`, { method: "POST", redirect: "error",
        signal: globalThis.AbortSignal.timeout(15_000), headers: { "content-type": "application/json",
          ...(revoke ? { authorization: `Bearer ${profile.workos.apiKey}` } : {}) }, body: JSON.stringify(body) });
      if (revoke) { await response.body?.cancel(); if (!response.ok) throw failure(); return; }
      if (!response.ok && response.status !== 403) { await response.body?.cancel(); throw failure(); }
      const reader = response.body?.getReader(); if (!reader) throw failure();
      const chunks = []; let size = 0;
      try { for (;;) { const part = await reader.read(); if (part.done) break;
        size += part.value.length; if (size > 128 * 1024) { await reader.cancel(); throw failure(); } chunks.push(part.value); }
      } finally { reader.releaseLock(); }
      return { ok: response.ok, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) };
    } catch { throw failure(); }
  };
  const login = async () => {
    const base = { client_id: profile.workos.desktopClientId, client_secret: profile.workos.apiKey };
    let reply = await api("authenticate", { ...base, grant_type: "password", email: fixture.expectedEmail,
      password: env.ZEROS_DEV_PASSWORD, organization_id: fixture.workosOrganizationId });
    if (!reply.ok && reply.body.code === "organization_selection_required") {
      const pending = reply.body;
      if (pending.user?.id !== fixture.workosUserId || pending.user?.email?.toLowerCase() !== fixture.expectedEmail.toLowerCase() ||
          !pending.organizations?.some(org => org.id === fixture.workosOrganizationId) ||
          typeof pending.pending_authentication_token !== "string") throw failure();
      reply = await api("authenticate", { ...base, grant_type: "urn:workos:oauth:grant-type:organization-selection",
        pending_authentication_token: pending.pending_authentication_token, organization_id: fixture.workosOrganizationId });
    }
    const value = reply.body;
    // Decode solely to retain this newly issued session for abandoned-login
    // cleanup. Electron main verifies the signature and full desktop contract.
    try { const claims = JSON.parse(Buffer.from(value.access_token.split(".")[1], "base64url").toString("utf8"));
      if (identifier.test(claims.sid ?? "")) sid = claims.sid;
    } catch { /* The refusal below never logs provider material. */ }
    if (!reply.ok || !sid || value.user?.id !== fixture.workosUserId || value.user?.email_verified !== true ||
        value.user?.email?.toLowerCase() !== fixture.expectedEmail.toLowerCase() ||
        value.organization_id !== fixture.workosOrganizationId || value.authentication_method !== "Password" ||
        ![value.access_token, value.refresh_token].every(v => typeof v === "string" && v.length >= 16 && v.length < 64 * 1024)) throw failure();
    if (closed) throw failure();
    writePrivateJson(path.join(directory, "session.json"), { version: 1, owner: descriptor.owner, runId,
      nonce: descriptor.nonce, expiresAt: Date.now() + 60_000, accessToken: value.access_token, refreshToken: value.refresh_token }, { create: true });
  };
  const close = () => closing ??= (async () => {
    closed = true; clearTimeout(timer);
    await flight?.catch(() => {});
    fs.rmSync(directory, { recursive: true, force: true });
    if (sid && !accepted) await api("sessions/revoke", { session_id: sid }, true);
  })();
  const timer = setTimeout(() => { void close().catch(() => {}); }, 10 * 60_000); timer.unref();
  return {
    environment: { ZEROS_CLOUD_DESKTOP_HANDOFF: file }, close,
    async handle(req, res) {
      if (!["/desktop-sign-in", "/desktop-sign-in/complete"].includes(req.url)) return false;
      const actual = Buffer.from(req.headers.authorization ?? ""), expected = Buffer.from(`Bearer ${descriptor.nonce}`);
      if (closed || req.method !== "POST" || Date.now() > descriptor.expiresAt || actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
        res.writeHead(404).end(); return true;
      }
      if (req.url.endsWith("/complete")) {
        // Only a result that main consumed can be accepted. Duplicate ACKs are
        // harmless; an abandoned file is revoked when this broker closes.
        if (!sid || !used || fs.existsSync(path.join(directory, "session.json"))) { res.writeHead(409).end(); return true; }
        accepted = true; res.writeHead(204).end(); return true;
      }
      if (used) { res.writeHead(409).end(); return true; }
      used = true; flight = login();
      try { await flight; res.writeHead(204).end(); }
      catch { res.writeHead(503).end(); }
      return true;
    },
  };
}
