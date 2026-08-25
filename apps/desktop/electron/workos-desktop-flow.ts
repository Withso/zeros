import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";

import type {
  WorkOSDesktopClient,
  WorkOSDesktopSession,
} from "./workos-desktop-client";

const CALLBACK_PATH = "/auth/callback";
const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const MAX_CALLBACK_VALUE_LENGTH = 8_192;

export type WorkOSDesktopFlowErrorReason =
  | "cancelled"
  | "expired"
  | "provider_error"
  | "callback_invalid"
  | "exchange_failed"
  | "account_failed"
  | "storage_failed";

class WorkOSDesktopFlowError extends Error {
  constructor(public readonly reason: WorkOSDesktopFlowErrorReason) {
    super(reason);
    this.name = "WorkOSDesktopFlowError";
  }
}

interface LoopbackCallback {
  redirectUri: string;
  result: Promise<{ code: string }>;
  close: () => void;
}

function sameState(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function safePage(
  response: ServerResponse,
  status: number,
  message: string,
): void {
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
    "content-type": "text/html; charset=utf-8",
    "x-content-type-options": "nosniff",
  });
  response.end(
    `<!doctype html><meta charset="utf-8"><title>Zeros sign-in</title><style>body{font:16px system-ui;margin:3rem;color:#18181b}</style><p>${message}</p>`,
  );
}

function callbackUrl(request: IncomingMessage, origin: string): URL | null {
  try {
    return new URL(request.url ?? "", origin);
  } catch {
    return null;
  }
}

async function createLoopbackCallback(
  expectedState: string,
  timeoutMs: number,
): Promise<LoopbackCallback> {
  let settled = false;
  let settleResolve!: (value: { code: string }) => void;
  let settleReject!: (error: WorkOSDesktopFlowError) => void;
  const result = new Promise<{ code: string }>((resolve, reject) => {
    settleResolve = resolve;
    settleReject = reject;
  });
  const server = createServer((request, response) => {
    const address = server.address() as AddressInfo | null;
    if (!address) {
      safePage(response, 503, "Zeros could not finish this sign-in.");
      return;
    }
    const expectedHost = `127.0.0.1:${address.port}`;
    const remote = request.socket.remoteAddress;
    const url = callbackUrl(request, `http://${expectedHost}`);
    if (remote !== "127.0.0.1" || request.headers.host !== expectedHost) {
      safePage(response, 400, "This callback was not accepted.");
      return;
    }
    if (request.method !== "GET" || url?.pathname !== CALLBACK_PATH) {
      safePage(response, 404, "This callback was not recognized.");
      return;
    }
    const state = url.searchParams.get("state") ?? "";
    if (!state || !sameState(state, expectedState)) {
      safePage(response, 400, "This sign-in did not match the app request.");
      return;
    }
    if (settled) {
      safePage(response, 409, "This sign-in callback was already used.");
      return;
    }
    settled = true;
    const providerError = url.searchParams.get("error");
    const code = url.searchParams.get("code") ?? "";
    if (providerError) {
      safePage(
        response,
        400,
        "Sign-in was not completed. You may close this tab.",
      );
      server.close();
      settleReject(new WorkOSDesktopFlowError("provider_error"));
      return;
    }
    if (!code || code.length > MAX_CALLBACK_VALUE_LENGTH) {
      safePage(response, 400, "The sign-in callback was incomplete.");
      server.close();
      settleReject(new WorkOSDesktopFlowError("callback_invalid"));
      return;
    }
    safePage(response, 200, "Sign-in is complete. You may return to Zeros.");
    server.close();
    settleResolve({ code });
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError);
      resolve();
    });
  });
  server.unref();
  const address = server.address() as AddressInfo;
  const timer = setTimeout(() => {
    if (settled) return;
    settled = true;
    server.close();
    settleReject(new WorkOSDesktopFlowError("expired"));
  }, timeoutMs);
  timer.unref?.();
  void result.finally(() => clearTimeout(timer)).catch(() => undefined);

  return {
    redirectUri: `http://127.0.0.1:${address.port}${CALLBACK_PATH}`,
    result,
    close() {
      if (settled) return;
      settled = true;
      server.close();
      settleReject(new WorkOSDesktopFlowError("cancelled"));
    },
  };
}

type FlowClient = Pick<
  WorkOSDesktopClient,
  "authorizationUrl" | "exchangeCode"
>;

export interface WorkOSDesktopAuthorizationFlowDeps {
  client: FlowClient;
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
  callback: LoopbackCallback;
  verifier: string;
}

export class WorkOSDesktopAuthorizationFlow {
  private pending: PendingFlow | null = null;

  constructor(private readonly deps: WorkOSDesktopAuthorizationFlowDeps) {}

  async start(): Promise<void> {
    this.cancel();
    const state = randomBytes(32).toString("base64url");
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256")
      .update(verifier, "ascii")
      .digest("base64url");
    const callback = await createLoopbackCallback(
      state,
      this.deps.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );
    const pending = { callback, verifier };
    this.pending = pending;
    const authorizationUrl = this.deps.client.authorizationUrl({
      state,
      codeChallenge: challenge,
      redirectUri: callback.redirectUri,
    });
    void this.complete(pending);
    try {
      await this.deps.openExternal(authorizationUrl);
    } catch (error) {
      if (this.pending === pending) {
        this.pending = null;
        callback.close();
      }
      throw error;
    }
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
      } catch {
        throw new WorkOSDesktopFlowError("exchange_failed");
      }
      if (this.pending !== pending) {
        await this.revokeAbandoned(session);
        return;
      }
      let accountId: string;
      try {
        accountId = await this.deps.resolveAccountId(session.accessToken);
      } catch {
        throw new WorkOSDesktopFlowError("account_failed");
      }
      if (this.pending !== pending) {
        await this.revokeAbandoned(session);
        return;
      }
      try {
        this.deps.persistSession({ ...session, accountId });
        persisted = true;
      } catch {
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
      const reason =
        error instanceof WorkOSDesktopFlowError
          ? error.reason
          : "exchange_failed";
      if (reason !== "cancelled") this.deps.onError(reason);
    }
  }

  private async revokeAbandoned(session: WorkOSDesktopSession): Promise<void> {
    try {
      await this.deps.revokeSession(session.accessToken);
    } catch {
      // The local session was never installed. Cleanup is best-effort because
      // the broker may be offline; the provider's access/session policy still
      // bounds an otherwise orphaned session.
    }
  }
}
