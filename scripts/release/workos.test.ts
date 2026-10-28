import { describe, expect, it } from "vitest";
import { verifyWorkOS, workosVerificationConfig } from "./workos";
import { WorkOSVerification } from "./contracts";

export const workosEnv = { AUTH_ISSUER: "https://auth-api.example.com/", AUTH_JWKS_URL: "https://auth-api.example.com/sso/jwks/client_desktop",
  AUTH_WEB_CLIENT_ID: "client_web", AUTH_DESKTOP_CLIENT_ID: "client_desktop" };
const config = { channel: "alpha" as const, app: "https://app-alpha.zeros.build", ops: "https://ops-alpha.zeros.build", surfaces: ["app", "ops"] as Array<"app" | "ops"> };
function fixture(change: (response: Response, surface: string) => Response = response => response) {
  const requests: Array<{ url: URL; headers: Headers; redirect: unknown }> = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input)); requests.push({ url, headers: new Headers(init?.headers), redirect: init?.redirect });
    if (url.pathname === "/auth/desktop") {
      const location = new URL("/user_management/authorize", workosEnv.AUTH_ISSUER);
      for (const [name, value] of Object.entries({ client_id: workosEnv.AUTH_DESKTOP_CLIENT_ID, redirect_uri: `${url.origin}/auth/desktop/callback`,
        response_type: "code", provider: "authkit", code_challenge_method: "S256", code_challenge: url.searchParams.get("code_challenge")!,
        state: url.searchParams.get("state")! })) location.searchParams.set(name, value);
      return change(new Response(null, { status: 303, headers: { location: location.href, "cache-control": "no-store", "referrer-policy": "no-referrer" } }), "desktop");
    }
    if (url.pathname === "/auth/start") {
      const location = new URL("/user_management/authorize", workosEnv.AUTH_ISSUER);
      for (const [name, value] of Object.entries({ client_id: workosEnv.AUTH_WEB_CLIENT_ID, redirect_uri: `${url.origin}/auth/callback`,
        response_type: "code", provider: "authkit", code_challenge_method: "S256", code_challenge: "c".repeat(43), state: "s".repeat(43) })) location.searchParams.set(name, value);
      return change(new Response(null, { status: 303, headers: { location: location.href, "cache-control": "no-store",
        "set-cookie": `__Host-zeros_auth_flow=${"f".repeat(43)}; Path=/; Secure; HttpOnly; SameSite=Lax` } }), url.origin);
    }
    if (url.pathname === "/user_management/authorize") return new Response(null, { status: 302, headers: { location: "https://authkit.example.com/login" } });
    return Response.json({ keys: [{ kid: "public-key", kty: "RSA", n: "public-modulus", e: "AQAB" }] });
  };
  return { fetcher, requests };
}
describe("post-Pages WorkOS handshake verification", () => {
  it.each(["alpha", "beta", "production"] as const)("qualifies the %s desktop client and exact channel callback as well as browser sign-in", async channel => {
    const app = `https://app${channel === "production" ? "" : `-${channel}`}.zeros.build`;
    const f = fixture();
    await verifyWorkOS({ ...config, channel, app, surfaces: ["app"] }, workosEnv, f.fetcher);
    const desktop = f.requests.find(request => request.url.pathname === "/auth/desktop");
    expect(desktop).toBeDefined();
    expect(desktop!.url.origin).toBe(app);
    expect(desktop!.url.searchParams.get("state")).toMatch(new RegExp(`^${channel === "production" ? "zeros" : `zeros-${channel}`}\\.[A-Za-z0-9_-]{43}$`));
    expect(desktop!.url.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const provider = f.requests.find(request => request.url.searchParams.get("client_id") === workosEnv.AUTH_DESKTOP_CLIENT_ID);
    expect(provider?.url.searchParams.get("redirect_uri")).toBe(`${app}/auth/desktop/callback`);
    expect(provider?.url.searchParams.get("state")).toBe(desktop!.url.searchParams.get("state"));
    expect(provider?.url.searchParams.get("code_challenge")).toBe(desktop!.url.searchParams.get("code_challenge"));
  });

  it.each(["client", "callback", "state", "challenge", "cache", "referrer", "provider-error"])("refuses desktop %s drift even when browser sign-in works", async change => {
    const f = fixture((response, surface) => {
      if (surface !== "desktop") return response;
      const location = new URL(response.headers.get("location")!);
      if (change === "client") location.searchParams.set("client_id", workosEnv.AUTH_WEB_CLIENT_ID);
      if (change === "callback") location.searchParams.set("redirect_uri", `${config.app}/auth/callback`);
      if (change === "state") location.searchParams.set("state", `zeros-beta.${"s".repeat(43)}`);
      if (change === "challenge") location.searchParams.set("code_challenge", "x".repeat(43));
      if (change === "cache") response.headers.delete("cache-control");
      if (change === "referrer") response.headers.delete("referrer-policy");
      response.headers.set("location", location.href);
      return response;
    });
    await expect(verifyWorkOS(config, workosEnv, async (url, init) => change === "provider-error" && new URL(String(url)).searchParams.get("client_id") === workosEnv.AUTH_DESKTOP_CLIENT_ID
      ? new Response(null, { status: 302, headers: { location: `${config.app}/auth/desktop/callback?error=invalid_request` } })
      : f.fetcher(url, init))).rejects.toThrow(/WorkOS/);
  });

  it("verifies every public facade, provider acceptance and signing keys without retaining flow credentials", async () => {
    const f = fixture(), result = await verifyWorkOS(config, workosEnv, f.fetcher);
    expect(result).toMatchObject({ kind: "workos-handshake-v1", surfaces: ["app", "ops"], desktopVerified: true });
    expect(f.requests).toHaveLength(7);
    expect(f.requests.every(request => !request.headers.has("authorization") && !request.headers.has("cookie"))).toBe(true);
    expect(JSON.stringify(result)).not.toContain("client_web"); expect(JSON.stringify(result)).not.toContain("f".repeat(43));
    expect(WorkOSVerification.parse(result).desktopVerified).toBe(true);
    const { desktopVerified: _, ...legacy } = result;
    expect(WorkOSVerification.parse(legacy)).not.toHaveProperty("desktopVerified");
    const desktop = f.requests.find(request => request.url.pathname === "/auth/desktop")!;
    expect(JSON.stringify(result)).not.toContain(desktop.url.searchParams.get("state"));
    expect(JSON.stringify(result)).not.toContain(desktop.url.searchParams.get("code_challenge"));
  });
  it.each(["origin", "callback", "client", "pkce", "cookie", "cookie-domain"])("refuses %s drift before worker qualification", async change => {
    const f = fixture(response => {
      const location = new URL(response.headers.get("location")!);
      if (change === "origin") location.hostname = "other.example.com";
      if (change === "callback") location.searchParams.set("redirect_uri", "https://app-beta.zeros.build/auth/callback");
      if (change === "client") location.searchParams.set("client_id", "client_other");
      if (change === "pkce") location.searchParams.delete("code_challenge_method");
      response.headers.set("location", location.href);
      if (change === "cookie") response.headers.set("set-cookie", "legacy=opaque; Path=/");
      if (change === "cookie-domain") response.headers.set("set-cookie", `__Host-zeros_auth_flow=${"f".repeat(43)}; Path=/; Secure; HttpOnly; SameSite=Lax; Domain=zeros.build`);
      return response;
    });
    await expect(verifyWorkOS(config, workosEnv, f.fetcher)).rejects.toThrow(/WorkOS/);
    expect(f.requests).toHaveLength(1);
  });
  it("refuses missing public configuration and never reflects a provider's private error body", async () => {
    expect(() => workosVerificationConfig({})).toThrow(/configuration/);
    const f = fixture();
    await expect(verifyWorkOS(config, workosEnv, async (url, init) => String(url).includes("/user_management/authorize")
      ? new Response("private-state-token", { status: 400 }) : f.fetcher(url, init))).rejects.toThrow("WorkOS rejected");
    await expect(verifyWorkOS(config, workosEnv, async (url, init) => String(url) === workosEnv.AUTH_JWKS_URL
      ? Response.json({ keys: [] }) : f.fetcher(url, init))).rejects.toThrow(/signing keys/);
  });
  it("does not count an OAuth error redirect as an accepted authorization request", async () => {
    const f = fixture();
    await expect(verifyWorkOS(config, workosEnv, async (url, init) => String(url).includes("/user_management/authorize")
      ? new Response(null, { status: 302, headers: { location: `${config.app}/auth/callback?error=invalid_request` } })
      : f.fetcher(url, init))).rejects.toThrow(/WorkOS/);
  });
  it.each([{ kid: "missing-public-key", kty: "RSA" }, { kid: "private-prime", kty: "RSA", n: "public-modulus", e: "AQAB", p: "private-fixture" }])(
    "requires usable public signing material without private fields", async key => {
      const f = fixture();
      await expect(verifyWorkOS(config, workosEnv, async (url, init) => String(url) === workosEnv.AUTH_JWKS_URL
        ? Response.json({ keys: [key] }) : f.fetcher(url, init))).rejects.toThrow(/signing keys/);
    });
});
