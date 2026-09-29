import type {
  CloudProviderAuthAction,
  CloudProviderAuthStatus,
} from "@zeros/protocol/provider-auth";
import { cloudProviderAuthStatusSchema } from "@zeros/protocol/provider-auth";

type Connect = Extract<CloudProviderAuthAction, { action: "connect" }>;
type Session = {
  sub: string;
  sessionId?: string;
  accountId?: string;
  accessToken: string;
};
export type CloudProviderAuthMaterial =
  | { nativeCache: unknown }
  | { apiKey: string; expiresAt: number };
interface Dependencies {
  reportFailure?(event: { provider: Connect["provider"]; phase: "provider-sign-in" | "cloud-save" | "account-check" }): void;
  session(): Promise<Session | null>;
  login(
    provider: Connect["provider"],
    signal: AbortSignal,
    code: (value: NonNullable<CloudProviderAuthStatus["deviceCode"]>) => void,
  ): Promise<CloudProviderAuthMaterial>;
  save(
    input: Connect,
    session: Session,
    material: CloudProviderAuthMaterial,
    signal: AbortSignal,
  ): Promise<NonNullable<CloudProviderAuthStatus["credential"]>>;
}
type Attempt = {
  request: Connect;
  owner: string;
  windowId: number;
  abort: AbortController;
  status: CloudProviderAuthStatus;
  done: Promise<void>;
};
const identity = (session: Session) =>
  JSON.stringify([
    session.sub,
    session.accountId ?? null,
    session.sessionId ?? null,
  ]);

export class CloudProviderAuthController {
  private readonly attempts = new Map<string, Attempt>();
  constructor(private readonly deps: Dependencies) {}

  async request(
    request: CloudProviderAuthAction,
    windowId: number,
  ): Promise<CloudProviderAuthStatus> {
    const session = await this.deps.session();
    if (!session) throw new Error("Sign in to connect a cloud agent account.");
    const owner = identity(session),
      existing = this.attempts.get(request.attemptId);
    if (existing) {
      if (existing.owner !== owner || existing.windowId !== windowId)
        throw new Error("Cloud sign-in is no longer available.");
      if (
        request.action === "connect" &&
        JSON.stringify(existing.request) !== JSON.stringify(request)
      )
        throw new Error("Cloud sign-in request changed.");
      if (request.action === "cancel") {
        this.cancel(existing);
        await existing.done;
      }
      return cloudProviderAuthStatusSchema.parse(existing.status);
    }
    if (request.action !== "connect")
      throw new Error("Cloud sign-in is no longer available.");
    if (
      [...this.attempts.values()].some(
        (attempt) =>
          attempt.windowId === windowId &&
          attempt.status.state === "connecting",
      )
    )
      throw new Error("Finish or cancel the current cloud sign-in first.");
    while (this.attempts.size >= 16) {
      const oldest = [...this.attempts.entries()].find(
        ([, attempt]) => attempt.status.state !== "connecting",
      );
      if (!oldest)
        throw new Error("Too many cloud sign-ins. Try again shortly.");
      this.attempts.delete(oldest[0]);
    }
    const attempt: Attempt = {
      request,
      owner,
      windowId,
      abort: new AbortController(),
      status: {
        attemptId: request.attemptId,
        provider: request.provider,
        organizationId: request.organizationId,
        state: "connecting",
      },
      done: Promise.resolve(),
    };
    this.attempts.set(request.attemptId, attempt);
    attempt.done = this.run(attempt);
    return cloudProviderAuthStatusSchema.parse(attempt.status);
  }

  private cancel(attempt: Attempt): void {
    if (attempt.status.state !== "connecting") return;
    attempt.abort.abort();
    attempt.status = {
      attemptId: attempt.request.attemptId,
      organizationId: attempt.request.organizationId,
      provider: attempt.request.provider,
      state: "canceled",
    };
  }
  async cancelWindow(windowId: number): Promise<void> {
    const attempts = [...this.attempts.values()].filter(
      (attempt) => attempt.windowId === windowId,
    );
    for (const attempt of attempts) this.cancel(attempt);
    await Promise.all(attempts.map((attempt) => attempt.done));
  }
  async stop(): Promise<void> {
    const attempts = [...this.attempts.values()];
    for (const attempt of attempts) this.cancel(attempt);
    await Promise.all(attempts.map((attempt) => attempt.done));
    for (const attempt of attempts)
      if (this.attempts.get(attempt.request.attemptId) === attempt)
        this.attempts.delete(attempt.request.attemptId);
  }
  private async run(attempt: Attempt): Promise<void> {
    const timer = setTimeout(() => this.cancel(attempt), 5 * 60_000);
    let phase: "provider-sign-in" | "cloud-save" | "account-check" = "provider-sign-in";
    try {
      const material = await this.deps.login(
        attempt.request.provider,
        attempt.abort.signal,
        (deviceCode) => {
          if (!attempt.abort.signal.aborted)
            attempt.status = cloudProviderAuthStatusSchema.parse({
              ...attempt.status,
              deviceCode,
            });
        },
      );
      attempt.abort.signal.throwIfAborted();
      phase = "account-check";
      const session = await this.deps.session();
      if (!session || identity(session) !== attempt.owner)
        throw new Error("Account changed");
      attempt.abort.signal.throwIfAborted();
      phase = "cloud-save";
      const credential = await this.deps.save(
        attempt.request,
        session,
        material,
        attempt.abort.signal,
      );
      attempt.abort.signal.throwIfAborted();
      phase = "account-check";
      const current = await this.deps.session();
      if (!current || identity(current) !== attempt.owner)
        throw new Error("Account changed");
      attempt.status = cloudProviderAuthStatusSchema.parse({
        attemptId: attempt.request.attemptId,
        organizationId: attempt.request.organizationId,
        provider: attempt.request.provider,
        state: "connected",
        credential,
      });
    } catch {
      // Never relay upstream auth errors: SDKs can include tokens or URLs.
      if (!attempt.abort.signal.aborted) {
        this.deps.reportFailure?.({ provider: attempt.request.provider, phase });
        attempt.status = {
          attemptId: attempt.request.attemptId,
          organizationId: attempt.request.organizationId,
          provider: attempt.request.provider,
          state: "failed",
          error: phase === "cloud-save"
            ? "You signed in, but Zeros could not save this cloud connection. Try again."
            : phase === "account-check"
              ? "Your Zeros sign-in changed. Reopen this dialog and try again."
              : "Could not complete the provider sign-in. Try again.",
        };
      }
    } finally {
      clearTimeout(timer);
    }
  }
}
