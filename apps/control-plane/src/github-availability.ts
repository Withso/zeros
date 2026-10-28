import { HttpError } from "./authz.js";

const MIN_RETRY_MS = 60_000;
const MAX_RETRY_MS = 24 * 60 * 60_000;

/** Only these closed outcomes may retain a previously verified source grant.
 * Authentication, provenance and ordinary permission failures never qualify. */
export function isGithubTemporary(error: unknown): error is HttpError {
  return error instanceof HttpError &&
    ((error.status === 429 && error.code === "github_rate_limited") ||
      (error.status === 503 && ["github_unavailable", "github_verification_busy", "github_verification_expired",
        "github_refresh_pending", "github_refresh_uncertain", "github_oauth_failed", "github_bad_response"].includes(error.code)));
}

export function isGithubAccessRevoked(error: unknown): error is HttpError {
  return error instanceof HttpError && ([401, 403, 404].includes(error.status) ||
    ["github_connection_required", "github_authorization_required", "github_authorization_expired"].includes(error.code));
}

export class GithubTemporaryError extends HttpError {
  constructor(code: "github_unavailable" | "github_rate_limited" | "github_verification_busy", readonly retryAfterMs = MIN_RETRY_MS) {
    super(code === "github_rate_limited" ? 429 : 503, code,
      code === "github_rate_limited" ? "GitHub is temporarily limiting requests. Try again shortly." : "GitHub access verification is temporarily unavailable. Try again shortly.");
  }
}

export function githubRetryAfter(response: Response, now = Date.now()): number {
  const value = response.headers.get("retry-after");
  const seconds = value && /^\d+(?:\.\d+)?$/.test(value) ? Number(value) * 1000 : NaN;
  const date = value ? Date.parse(value) - now : NaN;
  const reset = response.headers.get("x-ratelimit-remaining") === "0"
    ? Number(response.headers.get("x-ratelimit-reset")) * 1000 - now : NaN;
  return Math.min(MAX_RETRY_MS, Math.max(MIN_RETRY_MS, ...[seconds, date, reset].filter(Number.isFinite)));
}

/** GitHub uses 403 for secondary limits even with primary quota remaining.
 * Inspect a small error envelope, then discard it; never publish upstream text. */
export async function githubRateLimit(response: Response, now = Date.now()): Promise<GithubTemporaryError | null> {
  if (response.status !== 403 && response.status !== 429) return null;
  if (response.headers.get("x-github-sso")?.includes("required")) return null;
  let limited = response.status === 429 || response.headers.get("x-ratelimit-remaining") === "0" || response.headers.has("retry-after");
  if (!limited && response.body) {
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          reject(new GithubTemporaryError("github_unavailable"));
          void reader.cancel().catch(() => {});
        }, 2000);
        timer.unref();
      });
      for (;;) {
        const chunk = await Promise.race([reader.read(), deadline]);
        if (timedOut) throw new GithubTemporaryError("github_unavailable");
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > 16 * 1024) throw new GithubTemporaryError("github_unavailable");
        chunks.push(chunk.value);
      }
      const text = Buffer.concat(chunks).toString("utf8");
      let message: unknown;
      try { message = (JSON.parse(text) as { message?: unknown })?.message; } catch { /* Status still controls ordinary denials. */ }
      limited = typeof message === "string" && /\b(?:secondary rate limit|rate limit exceeded|abuse detection mechanism)\b/i.test(message);
    } catch (error) {
      if (error instanceof GithubTemporaryError) throw error;
      throw new GithubTemporaryError("github_unavailable");
    } finally {
      clearTimeout(timer);
      void reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
  if (!limited) return null;
  void response.body?.cancel().catch(() => {});
  return new GithubTemporaryError("github_rate_limited", githubRetryAfter(response, now));
}
