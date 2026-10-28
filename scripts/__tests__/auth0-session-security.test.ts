import { expect, it, vi } from "vitest";
import { getSessionWithId, refreshBrowserSession, type Env } from "../../apps/web/lib/session";
import { onRequestGet as logout } from "../../apps/web/functions/auth/logout";

it("does not let a late Auth0 refresh restore a logged-out browser session", async () => {
  const sessionId = "A".repeat(43);
  const data = { sub: "auth0|test", email: "test@example.test", name: null, accessToken: "old", refreshToken: "refresh", verifiedAt: 0 };
  const values = new Map([[`session:${sessionId}`, JSON.stringify(data)]]);
  const kvPut = vi.fn(async (key: string, value: string) => { values.set(key, value); });
  const env = { AUTH0_DOMAIN: "auth.example.test", AUTH0_CLIENT_ID: "test", AUTH0_CLIENT_SECRET: "synthetic", AUTH0_SESSION_AUTHORITY_KEY: "a".repeat(64),
    SESSIONS: { get: async (key: string) => values.get(key) ?? null, put: kvPut,
      delete: async (key: string) => { values.delete(key); } } } as unknown as Env;
  const request = new Request("https://app.zeros.build/auth/logout", { headers: { cookie: `zeros_session=${sessionId}` } });
  let release!: (response: Response) => void;
  let revoked = false;
  const grant = vi.fn(() => new Promise<Response>(resolve => { release = resolve; }));
  const actions: string[] = [];
  const fetcher = vi.fn(async (url: string, init: RequestInit) => {
    if (url.endsWith("/oauth/token")) return grant();
    const command = JSON.parse(init.body as string);
    actions.push(command.action);
    if (command.action === "revoke") revoked = true;
    if (revoked) return Response.json({ status: "terminal" });
    return Response.json({ status: command.action === "begin" ? "lease" : "active", lease: "B".repeat(43), data, revision: 1, expiresAt: Date.now() + 60_000 });
  });
  vi.stubGlobal("fetch", fetcher);
  try {
    const refreshing = refreshBrowserSession(env, sessionId, data);
    await vi.waitFor(() => expect(grant).toHaveBeenCalledTimes(1));
    await logout({ request, env } as never);
    release(Response.json({ access_token: "new", refresh_token: "rotated", expires_in: 3600 }));
    expect(await refreshing).toEqual({ ok: false, terminal: true });
    expect(await getSessionWithId(env, request)).toBeNull();
    expect(actions).not.toContain("create");
    expect(kvPut).not.toHaveBeenCalled();
    expect(values.has(`session:${sessionId}`)).toBe(true); // Stale KV is not authority.
  } finally { vi.unstubAllGlobals(); }
});
