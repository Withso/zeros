import { githubTokenHash, type GithubToken, type GithubTokens } from "./github";
import { githubAuthenticationError, GITHUB_REQUEST_TIMEOUT_MS } from "./github-failure";

const VALIDATION_INTERVAL_MS = 180_000;

/** Both tools share one validation flight. A failed command reports its token;
 * only the authentication read is retried, never the command's effects. */
export class GithubCredentialRecovery {
  private verified?: { hash: string; at: number };
  private flight?: { failed?: string; promise: Promise<GithubToken> };
  private generation = 0;
  constructor(private readonly tokens: Pick<GithubTokens, "get" | "invalidate">,
    private readonly options: { fetch?: typeof fetch; supportsRecovery: () => boolean }) {}

  disconnect(): void { this.verified = undefined; }

  invalidate(): void { this.generation++; this.verified = undefined; this.flight = undefined; }

  get(purpose: "git" | "gh", failedTokenSha256?: string): Promise<GithubToken> {
    if (this.flight && (!failedTokenSha256 || this.flight.failed === failedTokenSha256)) return this.flight.promise;
    if (this.flight) { this.tokens.invalidate(); this.invalidate(); }
    const deadline = Date.now() + GITHUB_REQUEST_TIMEOUT_MS, generation = this.generation;
    const promise = this.acquire(purpose, deadline, generation, failedTokenSha256).catch(error => {
      if (this.flight === flight) { this.verified = undefined; this.tokens.invalidate(); }
      throw error;
    });
    const flight = { failed: failedTokenSha256, promise };
    this.flight = flight;
    void promise.finally(() => { if (this.flight === flight) this.flight = undefined; }).catch(() => {});
    return promise;
  }

  private async acquire(purpose: "git" | "gh", deadline: number, generation: number, failed?: string): Promise<GithubToken> {
    const supported = this.options.supportsRecovery();
    const current = () => {
      if (generation !== this.generation) throw githubAuthenticationError("connection-changed");
      if (Date.now() >= deadline) throw githubAuthenticationError();
    };
    const request = async (hash?: string) => {
      current();
      if (hash && !supported) this.tokens.invalidate();
      const result = await this.tokens.get({ purpose: supported ? purpose : "gh", timeoutMs: deadline - Date.now(),
        ...(supported && hash ? { failedTokenSha256: hash } : {}) });
      current();
      if (githubTokenHash(result.token) === hash) { this.tokens.invalidate(); throw githubAuthenticationError("connection-expired"); }
      return result;
    };
    let credential = await request(failed);
    for (let attempt = 0; attempt < 2; attempt++) {
      current();
      if (credential.expiresAt <= Date.now()) throw githubAuthenticationError();
      const hash = githubTokenHash(credential.token);
      if (this.verified?.hash === hash && Date.now() - this.verified.at < VALIDATION_INTERVAL_MS && hash !== failed) return credential;
      let response: Response;
      try {
        response = await (this.options.fetch ?? fetch)("https://api.github.com/user", {
          method: "GET", redirect: "error", signal: AbortSignal.timeout(Math.min(3000, deadline - Date.now())),
          headers: { authorization: `Bearer ${credential.token}`, accept: "application/vnd.github+json", "user-agent": "zeros-cloud-worker" },
        });
      } catch { throw githubAuthenticationError(); }
      void response.body?.cancel().catch(() => {});
      current();
      if (credential.expiresAt <= Date.now()) throw githubAuthenticationError();
      if (response.ok) { this.verified = { hash, at: Date.now() }; return credential; }
      this.verified = undefined;
      if (response.status === 401) {
        this.tokens.invalidate();
        if (failed || attempt === 1) throw githubAuthenticationError("connection-expired");
        credential = await request(hash);
        continue;
      }
      if (response.status === 403 && response.headers.get("x-github-sso")?.includes("required")) throw githubAuthenticationError("sso-required");
      if (response.status === 429 || (response.status === 403 && (response.headers.has("retry-after") || response.headers.get("x-ratelimit-remaining") === "0"))) throw githubAuthenticationError("rate-limited");
      throw githubAuthenticationError(response.status === 403 ? "access-denied" : "unavailable");
    }
    throw githubAuthenticationError("connection-expired");
  }
}
