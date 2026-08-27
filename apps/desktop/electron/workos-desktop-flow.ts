import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import type {
  WorkOSDesktopClient,
  WorkOSDesktopSession,
} from "./workos-desktop-client";

const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const MAX_CALLBACK_VALUE_LENGTH = 8_192;
const MAX_STATE_LENGTH = 256;
const DESKTOP_SCHEME = /^zeros(?:-(?:alpha|beta|dev))?$/;

export type WorkOSDesktopFlowErrorReason =
  | "cancelled"
  | "expired"
  | "provider_error"
  | "callback_invalid"
  | "exchange_failed"
  | "verification_required"
  | "email_unverified"
  | "account_failed"
  | "storage_failed";

class WorkOSDesktopFlowError extends Error {
  constructor(public readonly reason: WorkOSDesktopFlowErrorReason) {
    super(reason);
    this.name = "WorkOSDesktopFlowError";
  }
}

export interface WorkOSDesktopAuthorizationCallback {
  state: string;
  code?: string | null;
  error?: string | null;
}

interface HostedCallback {
  result: Promise<{ code: string }>;
  accept: (input: WorkOSDesktopAuthorizationCallback) => boolean;
  close: () => void;
}

/** Log why a sign-in failed.
 *
 *  Every catch in this file used to be a bare `catch {}`, which DISCARDED the
 *  error rather than merely leaving it unlogged: the provider's refusal code,
 *  the HTTP status, and the specific contract violation were all destroyed
 *  before anything could report them. A failed desktop sign-in was therefore
 *  invisible from both the user's seat and the operator's.
 *
 *  Codes and statuses only — never tokens, claims, or the raw callback URL,
 *  matching the redaction rule the deep-link router already follows. */
function logSignInFailure(stage: string, error: unknown): void {
  const parts: string[] = [];
  if (error instanceof Error) parts.push(error.name);
  const detail = error as {
    code?: unknown;
    status?: unknown;
    providerCode?: unknown;
  };
  if (typeof detail?.code === "string") parts.push(`code=${detail.code}`);
  if (typeof detail?.providerCode === "string") {
    parts.push(`workos=${detail.providerCode}`);
  }
  if (typeof detail?.status === "number" && detail.status > 0) {
    parts.push(`status=${detail.status}`);
  }
  console.warn(
    `[Zeros] workos-signin ${stage} failed${parts.length ? `: ${parts.join(" ")}` : ""}`,
  );
}

/** Map a client/account refusal onto the reason the UI explains to the user. */
function exchangeReason(
  error: unknown,
): Extract<
  WorkOSDesktopFlowErrorReason,
  "exchange_failed" | "verification_required" | "email_unverified"
> {
  const detail = error as { code?: unknown; providerCode?: unknown };
  if (detail?.providerCode === "email_verification_required") {
    return "verification_required";
  }
  // `user_email_unverified` is our own contract check; `email_unverified` is the
  // token-claim check. Both mean the provider has not proven this address.
  if (
    detail?.code === "user_email_unverified" ||
    detail?.code === "email_unverified"
  ) {
    return "email_unverified";
  }
  return "exchange_failed";
}

function accountReason(
  error: unknown,
): Extract<
  WorkOSDesktopFlowErrorReason,
  "account_failed" | "email_unverified"
> {
  return (error as { code?: unknown })?.code === "email_unverified"
    ? "email_unverified"
    : "account_failed";
}

function sameState(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function createHostedCallback(
  expectedState: string,
  timeoutMs: number,
): HostedCallback {
  let settled = false;
  let settleResolve!: (value: { code: string }) => void;
  let settleReject!: (error: WorkOSDesktopFlowError) => void;
  const result = new Promise<{ code: string }>((resolve, reject) => {
    settleResolve = resolve;
    settleReject = reject;
  });
  const timer = setTimeout(() => {
    if (settled) return;
    settled = true;
    settleReject(new WorkOSDesktopFlowError("expired"));
  }, timeoutMs);
  timer.unref?.();
  void result.finally(() => clearTimeout(timer)).catch(() => undefined);

  return {
    result,
    accept(input) {
      if (settled) return false;
      if (
        !input.state ||
        input.state.length > MAX_STATE_LENGTH ||
        !sameState(input.state, expectedState)
      ) {
        return false;
      }
      settled = true;
      const code = input.code ?? "";
      const providerError = input.error ?? "";
      if (providerError && !code) {
        settleReject(new WorkOSDesktopFlowError("provider_error"));
        return true;
      }
      if (!code || code.length > MAX_CALLBACK_VALUE_LENGTH || providerError) {
        settleReject(new WorkOSDesktopFlowError("callback_invalid"));
        return true;
      }
      settleResolve({ code });
      return true;
    },
    close() {
      if (settled) return;
      settled = true;
      settleReject(new WorkOSDesktopFlowError("cancelled"));
    },
  };
}

type FlowClient = Pick<WorkOSDesktopClient, "exchangeCode">;

export interface WorkOSDesktopAuthorizationFlowDeps {
  client: FlowClient;
  appOrigin: string;
  deepLinkScheme: string;
  openExternal: (url: string) => Promise<void>;
  resolveAccountId: (accessToken: string) => Promise<string>;
  persistSession: (
    session: WorkOSDesktopSession & { accountId: string },
  ) => void;
  /** Revoke a provider session that was minted but could not be installed. */
  revokeSession: (accessToken: string) => Promise<void>;
  onComplete: () => void;
  onError: (reason: Exclude<WorkOSDesktopFlowErrorReason, "cancelled">) => void;
  timeoutMs?: number;
}

interface PendingFlow {
  callback: HostedCallback;
  verifier: string;
}

function authorizationPageUrl(
  appOrigin: string,
  state: string,
  codeChallenge: string,
): string {
  const origin = new URL(appOrigin);
  const loopback =
    origin.protocol === "http:" &&
    ["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname);
  if (
    (origin.protocol !== "https:" && !loopback) ||
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash
  ) {
    throw new Error("Desktop sign-in app origin is invalid");
  }
  const url = new URL("/auth/desktop", origin);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", codeChallenge);
  return url.toString();
}

export class WorkOSDesktopAuthorizationFlow {
  private pending: PendingFlow | null = null;

  constructor(private readonly deps: WorkOSDesktopAuthorizationFlowDeps) {}

  async start(): Promise<void> {
    this.cancel();
    if (!DESKTOP_SCHEME.test(this.deps.deepLinkScheme)) {
      throw new Error("Desktop sign-in scheme is invalid");
    }
    const state = `${this.deps.deepLinkScheme}.${randomBytes(32).toString("base64url")}`;
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256")
      .update(verifier, "ascii")
      .digest("base64url");
    const startUrl = authorizationPageUrl(
      this.deps.appOrigin,
      state,
      challenge,
    );
    const callback = createHostedCallback(
      state,
      this.deps.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );
    const pending = { callback, verifier };
    this.pending = pending;
    void this.complete(pending);
    try {
      await this.deps.openExternal(startUrl);
    } catch (error) {
      if (this.pending === pending) {
        this.pending = null;
        callback.close();
      }
      throw error;
    }
  }

  acceptCallback(input: WorkOSDesktopAuthorizationCallback): boolean {
    return this.pending?.callback.accept(input) ?? false;
  }

  cancel(): boolean {
    const pending = this.pending;
    if (!pending) return false;
    this.pending = null;
    pending.callback.close();
    return true;
  }

  private async complete(pending: PendingFlow): Promise<void> {
    let session: WorkOSDesktopSession | null = null;
    let persisted = false;
    try {
      const { code } = await pending.callback.result;
      try {
        session = await this.deps.client.exchangeCode({
          code,
          codeVerifier: pending.verifier,
        });
      } catch (error) {
        logSignInFailure("code exchange", error);
        throw new WorkOSDesktopFlowError(exchangeReason(error));
      }
      if (this.pending !== pending) {
        await this.revokeAbandoned(session);
        return;
      }
      let accountId: string;
      try {
        accountId = await this.deps.resolveAccountId(session.accessToken);
      } catch (error) {
        logSignInFailure("account lookup", error);
        throw new WorkOSDesktopFlowError(accountReason(error));
      }
      if (this.pending !== pending) {
        await this.revokeAbandoned(session);
        return;
      }
      try {
        this.deps.persistSession({ ...session, accountId });
        persisted = true;
      } catch (error) {
        logSignInFailure("session storage", error);
        throw new WorkOSDesktopFlowError("storage_failed");
      }
      if (this.pending !== pending) return;
      this.pending = null;
      this.deps.onComplete();
    } catch (error) {
      if (session && !persisted) await this.revokeAbandoned(session);
      if (this.pending !== pending) return;
      this.pending = null;
      pending.callback.close();
      let reason: WorkOSDesktopFlowErrorReason;
      if (error instanceof WorkOSDesktopFlowError) {
        reason = error.reason;
      } else {
        // Anything reaching here is unexpected — the staged catches above name
        // everything we anticipate. Log it rather than silently reporting the
        // generic exchange failure it is about to be reported as.
        logSignInFailure("sign-in", error);
        reason = "exchange_failed";
      }
      if (reason !== "cancelled") this.deps.onError(reason);
    }
  }

  private async revokeAbandoned(session: WorkOSDesktopSession): Promise<void> {
    try {
      await this.deps.revokeSession(session.accessToken);
    } catch {
      // The local session was never installed. Cleanup is best-effort because
      // Railway may be offline; provider policy still bounds the session.
    }
  }
}
