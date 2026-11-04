import { githubTokenHash, type GithubToken, type GithubTokens } from "./github";
import { githubAuthenticationError, GITHUB_REQUEST_TIMEOUT_MS } from "./github-failure";

const VALIDATION_INTERVAL_MS = 180_000;
const VALIDATION_RETRY_MS = 60_000;
const VALIDATION_HANDOFF_MS = 100;

/** Both tools share one validation flight. A failed command reports its token;
 * only the authentication read is retried, never the command's effects. */
export class GithubCredentialRecovery {
  private validation?: { hash: string; nextAt: number };
  private flight?: { reports: Set<string>; promise: Promise<GithubToken> };
  private generation = 0;
  private transportRevision = 0;
  constructor(private readonly tokens: Pick<GithubTokens, "get" | "invalidate">,
    private readonly options: { fetch?: typeof fetch; supportsRecovery: () => boolean }) {}

  disconnect(): void { this.transportRevision++; this.validation = undefined; }

  invalidate(): void { this.generation++; this.validation = undefined; this.flight = undefined; }

  get(purpose: "git" | "gh", failedTokenSha256?: string): Promise<GithubToken> {
    if (this.flight) {
      if (failedTokenSha256) this.flight.reports.add(failedTokenSha256);
      return this.flight.promise;
    }
    const deadline = Date.now() + GITHUB_REQUEST_TIMEOUT_MS, generation = this.generation;
    const reports = new Set(failedTokenSha256 ? [failedTokenSha256] : []);
    const promise = this.acquire(purpose, deadline, generation, reports, failedTokenSha256).catch(error => {
      if (this.flight === flight) { this.validation = undefined; this.tokens.invalidate(); }
      throw error;
    });
    const flight = { reports, promise };
    this.flight = flight;
    void promise.finally(() => { if (this.flight === flight) this.flight = undefined; }).catch(() => {});
    return promise;
  }

  private async acquire(purpose: "git" | "gh", deadline: number, generation: number, reports: Set<string>, failed?: string): Promise<GithubToken> {
    const supported = this.options.supportsRecovery();
    let transportRevision = this.transportRevision;
    const current = () => {
      if (generation !== this.generation) throw githubAuthenticationError("connection-changed");
      if (Date.now() >= deadline) throw githubAuthenticationError();
    };
    const request = async (hash?: string) => {
      for (;;) {
        current();
        const revision = this.transportRevision;
        if (hash && !supported) this.tokens.invalidate();
        const result = await this.tokens.get({ purpose: supported ? purpose : "gh", timeoutMs: deadline - Date.now(),
          ...(supported && hash ? { failedTokenSha256: hash } : {}) });
        current();
        if (revision !== this.transportRevision) continue;
        transportRevision = revision;
        if (githubTokenHash(result.token) === hash) { this.tokens.invalidate(); throw githubAuthenticationError("connection-expired"); }
        return result;
      }
    };
    let credential = await request(failed);
    let refreshed = failed !== undefined;
    for (;;) {
      current();
      if (transportRevision !== this.transportRevision) { credential = await request(); continue; }
      if (credential.expiresAt <= Date.now()) throw githubAuthenticationError();
      const hash = githubTokenHash(credential.token);
      if (!reports.has(hash) && this.validation?.hash === hash && Date.now() < this.validation.nextAt) return credential;
      let response: Response | undefined;
      const timeout = Math.min(3000, deadline - Date.now() - VALIDATION_HANDOFF_MS);
      if (!reports.has(hash) && timeout > 0) {
        try {
          response = await (this.options.fetch ?? fetch)("https://api.github.com/user", {
            method: "GET", redirect: "error", signal: AbortSignal.timeout(timeout),
            headers: { authorization: `Bearer ${credential.token}`, accept: "application/vnd.github+json", "user-agent": "zeros-cloud-worker" },
          });
        } catch { response = undefined; }
        void response?.body?.cancel().catch(() => {});
      }
      current();
      if (credential.expiresAt <= Date.now()) throw githubAuthenticationError();
      if (reports.has(hash) || response?.status === 401) {
        this.validation = undefined;
        this.tokens.invalidate();
        if (refreshed) throw githubAuthenticationError("connection-expired");
        refreshed = true;
        credential = await request(hash);
        continue;
      }
      if (transportRevision !== this.transportRevision) { credential = await request(); continue; }
      this.validation = { hash, nextAt: Date.now() + (response?.ok ? VALIDATION_INTERVAL_MS : VALIDATION_RETRY_MS) };
      return credential;
    }
  }
}
