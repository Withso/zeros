import { createServer } from "node:http";
import { once } from "node:events";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { abortable, ZerosDevWorkOSPasswordProvider } from "./zeros-dev-auth-workos.js";
import type { AuthBackendConfig } from "./config.js";

describe("zeros-dev uses WorkOS desktop tokens without challenge bypasses", () => {
  const identity = { subject: "user_fixture", email: "fixture@example.test", accountId: "11111111-1111-4111-8111-111111111111", organizationId: "22222222-2222-4222-8222-222222222222" };
  const backend = { appOrigin: "https://app-alpha.zeros.build", opsOrigin: null, apiKey: "synthetic-workos-key", cookiePassword: "unused-synthetic", webhookSecret: "unused-synthetic" };
  const server = createServer();
  let auth: Extract<AuthBackendConfig,{provider:"workos"}>;
  let privateKey: CryptoKey;
  beforeAll(async () => {
    const keys = await generateKeyPair("RS256"); privateKey = keys.privateKey;
    const jwk = await exportJWK(keys.publicKey);
    server.on("request", (_request,response) => { response.setHeader("content-type","application/json"); response.end(JSON.stringify({keys:[{...jwk,kid:"fixture",alg:"RS256"}]})); });
    server.listen(0,"127.0.0.1"); await once(server,"listening");
    const address=server.address(); if(!address||typeof address==="string") throw new Error("fixture listen failed");
    auth={provider:"workos",issuer:"https://api.workos.com/user_management/client_fixture_web",audience:"https://api-alpha.zeros.build",webClientId:"client_fixture_web",desktopClientId:"client_fixture_desktop",jwksUrl:`http://127.0.0.1:${address.port}/jwks`};
  });
  afterAll(async () => { await new Promise<void>(resolve=>server.close(()=>resolve())); });
  const token=async (extra={})=>new SignJWT({sid:"session_fixture",jti:"token_fixture",client_id:auth.desktopClientId,
    "https://zeros.build/email":identity.email,"https://zeros.build/email_verified":true,...extra})
    .setProtectedHeader({alg:"RS256",kid:"fixture"}).setSubject(identity.subject).setIssuedAt().setExpirationTime("5m")
    .setIssuer(auth.issuer).setAudience(auth.audience).sign(privateKey);

  it("sends only the fixed email/client and password to a fixed endpoint and verifies real signatures", async () => {
    const access=await token();
    const fetcher=vi.fn<typeof fetch>(async()=>Response.json({access_token:access,refresh_token:"synthetic-refresh",authentication_method:"Password",user:{id:identity.subject,email:identity.email,email_verified:true}}));
    const provider=new ZerosDevWorkOSPasswordProvider(auth,backend,fetcher);
    const signal=AbortSignal.timeout(2000);
    const result=await provider.issue(identity,"synthetic-password",signal);
    expect(fetcher.mock.calls[0]?.[0]).toBe("https://api.workos.com/user_management/authenticate");
    const init=fetcher.mock.calls[0]?.[1];
    expect(init).toMatchObject({method:"POST",redirect:"error",credentials:"omit",signal});
    expect(JSON.parse(String(init?.body))).toEqual({client_id:auth.desktopClientId,client_secret:backend.apiKey,grant_type:"password",email:identity.email,password:"synthetic-password"});
    expect(await provider.verify(result.accessToken)).toMatchObject({providerSubject:identity.subject,clientKind:"desktop",sessionId:"session_fixture",emailVerified:true});
    await expect(provider.verify(access.slice(0,-10)+"corrupted")).rejects.toThrow();
    await expect(provider.verify(await token({client_id:"foreign-client"}))).rejects.toThrow();
    await expect(provider.verify(await token({"https://zeros.build/email_verified":false}))).rejects.toThrow();
  });

  it.each(["mfa_challenge","email_verification_required","sso_required","password_grant_disabled"])("does not follow %s", async code => {
    const fetcher=vi.fn<typeof fetch>(async()=>Response.json({code,pending_authentication_token:"synthetic-challenge"},{status:401}));
    const provider=new ZerosDevWorkOSPasswordProvider(auth,backend,fetcher);
    await expect(provider.issue(identity,"synthetic-password",AbortSignal.timeout(2000))).rejects.toThrow("zeros_dev_auth_denied");
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("bounds an untrusted response and accepts no redirected login", async () => {
    for(const response of [new Response("x".repeat(128*1024+1)),new Response(null,{status:302,headers:{location:"https://foreign.example"}})]) {
      const fetcher=vi.fn<typeof fetch>(async()=>response);
      const provider=new ZerosDevWorkOSPasswordProvider(auth,backend,fetcher);
      await expect(provider.issue(identity,"synthetic-password",AbortSignal.timeout(2000))).rejects.toThrow();
      expect(fetcher).toHaveBeenCalledOnce();
    }
  });

  it("observes late rejection even when its deadline already elapsed", async () => {
    let reject!: (reason: Error) => void;
    const operation = new Promise<void>((_resolve, fail) => { reject = fail; });
    const observed = vi.spyOn(operation, "then");
    // Keep the red run contained; the implementation must attach its own handler.
    const contained = operation.catch(() => {});
    const before = observed.mock.calls.length;
    await expect(abortable(operation, AbortSignal.abort())).rejects.toThrow();
    const after = observed.mock.calls.length;
    reject(new Error("synthetic late failure"));
    await contained;
    expect(after).toBeGreaterThan(before);
  });

  it.each(["pending_authentication_token", "authentication_challenge", "code"])("withholds an unexpected successful grant containing %s", async field => {
    const fetcher=vi.fn<typeof fetch>(async()=>Response.json({access_token:await token(),refresh_token:"synthetic-refresh",authentication_method:"Password",
      user:{id:identity.subject,email:identity.email,email_verified:true},[field]:"synthetic-challenge"}));
    const provider=new ZerosDevWorkOSPasswordProvider(auth,backend,fetcher);
    const grant=await provider.issue(identity,"synthetic-password",AbortSignal.timeout(2000));
    expect(grant.sessionId).toBe("session_fixture"); // retained for revocation
    expect(grant.authenticationMethod).not.toBe("Password");
  });

  it("revokes the exact issued session through the existing WorkOS API", async () => {
    const fetcher=vi.fn<typeof fetch>(async()=>new Response(null,{status:204}));
    const provider=new ZerosDevWorkOSPasswordProvider(auth,backend,fetcher);
    await provider.revoke("session_fixture",AbortSignal.timeout(2000));
    expect(fetcher.mock.calls[0]?.[0]).toBe("https://api.workos.com/user_management/sessions/revoke");
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({session_id:"session_fixture"});
    await expect(provider.revoke("../foreign",AbortSignal.timeout(2000))).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledOnce();
  });
});
