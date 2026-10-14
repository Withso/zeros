import { createRemoteJWKSet, decodeJwt, jwtVerify } from "jose";
import type { AuthBackendConfig, WorkOSBackendConfig } from "./config.js";
import { authTokenVerifyOptions, validateAuthTokenClaims, type AuthTokenClaims } from "./auth-token-contract.js";
import { ZerosDevAuthError, type ZerosDevAuthConfig } from "./zeros-dev-auth-config.js";

const ORIGIN = "https://api.workos.com";
const IDENTIFIER = /^[A-Za-z0-9_-]{1,512}$/;
export type ZerosDevIssuedGrant = {
  accessToken: string; refreshToken: string; sessionId: string;
  subject: string; email: string; emailVerified: boolean; authenticationMethod: string;
};
export interface ZerosDevPasswordProvider {
  issue(identity: ZerosDevAuthConfig, password: string, signal: AbortSignal): Promise<ZerosDevIssuedGrant>;
  verify(token: string): Promise<AuthTokenClaims>;
  revoke(sessionId: string, signal: AbortSignal): Promise<void>;
}

export async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new ZerosDevAuthError("unavailable"));
    // Observe the already-created operation even if the caller's deadline
    // elapsed before this wrapper could attach. Late rejection is still owned.
    promise.then(value => { signal.removeEventListener("abort", abort); resolve(value); },
      error => { signal.removeEventListener("abort", abort); reject(error); });
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
}

/** Both the anonymous request and WorkOS response are streamed under a byte
 * bound and the same deadline. A false Content-Length never defeats it. */
export async function boundedJson(message: Request | Response, max: number, signal: AbortSignal): Promise<unknown> {
  const length = Number(message.headers.get("content-length") ?? 0);
  if (!Number.isFinite(length) || length < 0 || length > max || !message.body) throw new ZerosDevAuthError("denied");
  const reader = message.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await abortable(reader.read(), signal);
      if (part.done) break;
      size += part.value.byteLength;
      if (size > max) throw new ZerosDevAuthError("denied");
      chunks.push(part.value);
    }
    return JSON.parse(Buffer.concat(chunks, size).toString("utf8"));
  } finally {
    void reader.cancel().catch(() => {});
  }
}

/** Uses WorkOS's existing Desktop Application, never a locally issued token.
 * The transport seam is injectable for fake-WorkOS tests, not environment URLs. */
export class ZerosDevWorkOSPasswordProvider implements ZerosDevPasswordProvider {
  private readonly keys: ReturnType<typeof createRemoteJWKSet>;
  constructor(
    private readonly auth: Extract<AuthBackendConfig, { provider: "workos" }>,
    private readonly backend: WorkOSBackendConfig,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly verifyImpl?: (token: string) => Promise<AuthTokenClaims>,
  ) {
    this.keys = createRemoteJWKSet(new URL(auth.jwksUrl), { timeoutDuration: 2_000, cooldownDuration: 300_000 });
  }

  async issue(identity: ZerosDevAuthConfig, password: string, signal: AbortSignal): Promise<ZerosDevIssuedGrant> {
    const response = await this.fetchImpl(`${ORIGIN}/user_management/authenticate`, {
      method: "POST", redirect: "error", credentials: "omit", signal,
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ client_id: this.auth.desktopClientId, client_secret: this.backend.apiKey,
        grant_type: "password", email: identity.email, password }),
    });
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      // No challenge, pending token or provider error is exposed to a caller.
      throw new ZerosDevAuthError(response.status >= 500 ? "unavailable" : "denied");
    }
    // Admission may already have closed while WorkOS issued a session. A
    // received successful response gets a separate bounded cleanup window:
    // decode its SID so the route can tombstone/revoke, never to extend login.
    let body: Record<string, unknown> | null;
    try { body = await boundedJson(response, 128 * 1024, AbortSignal.timeout(2_000)) as Record<string, unknown> | null; }
    catch { throw new ZerosDevAuthError("unavailable"); }
    const token = body?.access_token;
    // This unverified sid is used ONLY to revoke the grant returned by our
    // fixed TLS WorkOS endpoint if its later signature/contract check fails.
    // No caller token or claim can enter this path or authorize a success.
    let sessionId: unknown;
    try { sessionId = typeof token === "string" && token.length <= 64 * 1024 ? decodeJwt(token).sid : null; }
    catch { throw new ZerosDevAuthError("unavailable"); }
    if (typeof sessionId !== "string" || !IDENTIFIER.test(sessionId)) throw new ZerosDevAuthError("unavailable");
    const user = body?.user as Record<string, unknown> | undefined;
    return { accessToken: token as string,
      refreshToken: typeof body?.refresh_token === "string" && body.refresh_token.length <= 64 * 1024 ? body.refresh_token : "",
      sessionId, subject: typeof user?.id === "string" ? user.id : "",
      email: typeof user?.email === "string" ? user.email.trim().toLowerCase() : "",
      emailVerified: user?.email_verified === true,
      authenticationMethod: !["pending_authentication_token", "authentication_challenge", "code", "error"].some(key => key in (body ?? {})) &&
        typeof body?.authentication_method === "string" ? body.authentication_method : "" };
  }

  async verify(token: string): Promise<AuthTokenClaims> {
    if (this.verifyImpl) return this.verifyImpl(token);
    const { payload } = await jwtVerify(token, this.keys, authTokenVerifyOptions(this.auth));
    return validateAuthTokenClaims(payload, this.auth);
  }

  async revoke(sessionId: string, signal: AbortSignal): Promise<void> {
    if (!IDENTIFIER.test(sessionId)) throw new ZerosDevAuthError("denied");
    const response = await this.fetchImpl(`${ORIGIN}/user_management/sessions/revoke`, {
      method: "POST", redirect: "error", credentials: "omit", signal,
      headers: { "content-type": "application/json", authorization: `Bearer ${this.backend.apiKey}` },
      body: JSON.stringify({ session_id: sessionId }),
    });
    void response.body?.cancel().catch(() => {});
    if (!response.ok && response.status !== 404) throw new ZerosDevAuthError("unavailable");
  }
}
