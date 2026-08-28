import { afterEach, describe, expect, it, vi } from "vitest";

import {
  WorkOSDesktopAuthorizationFlow,
  type WorkOSDesktopAuthorizationFlowDeps,
} from "../workos-desktop-flow";
import type { WorkOSDesktopSession } from "../workos-desktop-client";

const session: WorkOSDesktopSession = {
  accessToken: "access-token",
  refreshToken: "refresh-token",
  expiresAt: Date.now() + 300_000,
  providerSubject: "user_example",
  sessionId: "session_example",
  clientKind: "desktop",
  email: "person@example.com",
  name: "Example Person",
  authenticationMethod: "GoogleOAuth",
};

const controllers: WorkOSDesktopAuthorizationFlow[] = [];

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function setup(overrides: Partial<WorkOSDesktopAuthorizationFlowDeps> = {}) {
  const completed = deferred<void>();
  let openedUrl: string | null = null;
  const exchangeCode = vi.fn(async () => session);
  const persistSession = vi.fn();
  const revokeSession = vi.fn(async () => {});
  const deps: WorkOSDesktopAuthorizationFlowDeps = {
    client: { exchangeCode },
    appOrigin: "https://app-alpha.zeros.build",
    deepLinkScheme: "zeros-alpha",
    openExternal: async (url) => {
      openedUrl = url;
    },
    resolveAccountId: async () => "00000000-0000-4000-8000-000000000001",
    persistSession,
    revokeSession,
    onComplete: () => completed.resolve(),
    onError: vi.fn(),
    timeoutMs: 5_000,
    ...overrides,
  };
  const flow = new WorkOSDesktopAuthorizationFlow(deps);
  controllers.push(flow);
  return {
    flow,
    deps,
    completed,
    exchangeCode,
    persistSession,
    revokeSession,
    get openedUrl() {
      return openedUrl;
    },
  };
}

function callbackState(openedUrl: string): string {
  return new URL(openedUrl).searchParams.get("state")!;
}

afterEach(() => {
  for (const flow of controllers.splice(0)) flow.cancel();
});

describe("WorkOS desktop hosted authorization", () => {
  it("rejects an invalid app origin without leaving a pending flow", async () => {
    const harness = setup({ appOrigin: "http://untrusted.example" });

    await expect(harness.flow.start()).rejects.toThrow(
      "Desktop sign-in app origin is invalid",
    );
    expect(harness.openedUrl).toBeNull();
    expect(harness.flow.cancel()).toBe(false);
  });

  it("opens the branded app-host page and consumes a matching deep-link callback once", async () => {
    const harness = setup();
    const startedAt = Date.now();
    const attempt = await harness.flow.start();
    const returnedAt = Date.now();

    expect(attempt.expiresAt).toBeGreaterThanOrEqual(startedAt + 5_000);
    expect(attempt.expiresAt).toBeLessThanOrEqual(returnedAt + 5_000);

    const opened = new URL(harness.openedUrl!);
    expect(opened.origin).toBe("https://app-alpha.zeros.build");
    expect(opened.pathname).toBe("/auth/desktop");
    expect(opened.searchParams.get("state")).toMatch(
      /^zeros-alpha\.[A-Za-z0-9_-]{43}$/,
    );
    expect(opened.searchParams.get("code_challenge")).toMatch(
      /^[A-Za-z0-9_-]{43}$/,
    );
    expect(opened.toString()).not.toContain("api.workos.com");

    expect(
      harness.flow.acceptCallback({
        state: callbackState(harness.openedUrl!),
        code: "authorization-code",
      }),
    ).toBe(true);
    await harness.completed.promise;

    expect(harness.exchangeCode).toHaveBeenCalledWith({
      code: "authorization-code",
      codeVerifier: expect.any(String),
    });
    expect(harness.persistSession).toHaveBeenCalledWith({
      ...session,
      accountId: "00000000-0000-4000-8000-000000000001",
    });
    expect(
      harness.flow.acceptCallback({
        state: callbackState(harness.openedUrl!),
        code: "replayed-code",
      }),
    ).toBe(false);
  });

  it("ignores a mismatched state without consuming the legitimate callback", async () => {
    const harness = setup();
    await harness.flow.start();

    expect(
      harness.flow.acceptCallback({
        state: `zeros-alpha.${"x".repeat(43)}`,
        code: "attacker-code",
      }),
    ).toBe(false);
    expect(harness.exchangeCode).not.toHaveBeenCalled();
    expect(
      harness.flow.acceptCallback({
        state: callbackState(harness.openedUrl!),
        code: "real-code",
      }),
    ).toBe(true);
    await harness.completed.promise;

    expect(harness.exchangeCode).toHaveBeenCalledTimes(1);
    expect(harness.exchangeCode).toHaveBeenCalledWith({
      code: "real-code",
      codeVerifier: expect.any(String),
    });
  });

  it("turns a matching provider error into a bounded desktop failure", async () => {
    const error = deferred<void>();
    const onError = vi.fn(() => error.resolve());
    const harness = setup({ onError });
    await harness.flow.start();

    expect(
      harness.flow.acceptCallback({
        state: callbackState(harness.openedUrl!),
        error: "provider_error",
      }),
    ).toBe(true);
    await error.promise;

    expect(onError).toHaveBeenCalledWith("provider_error");
    expect(harness.exchangeCode).not.toHaveBeenCalled();
  });

  it("fails closed instead of performing an out-of-band verification grant", async () => {
    const verificationRequired = Object.assign(new Error("rejected"), {
      code: "exchange_rejected",
      status: 403,
      providerCode: "email_verification_required",
    });
    const exchangeCode = vi.fn(async () => {
      throw verificationRequired;
    });
    const outOfBandContinuation = vi.fn(async () => session);
    const error = deferred<void>();
    const onError = vi.fn(() => error.resolve());
    const legacyClient = {
      exchangeCode,
      completeGitHubVerification: outOfBandContinuation,
    };
    const harness = setup({
      onError,
      client: legacyClient,
    });
    await harness.flow.start();

    expect(
      harness.flow.acceptCallback({
        state: callbackState(harness.openedUrl!),
        code: "real-code",
      }),
    ).toBe(true);
    await error.promise;

    expect(exchangeCode).toHaveBeenCalledOnce();
    expect(exchangeCode).toHaveBeenCalledWith({
      code: "real-code",
      codeVerifier: expect.any(String),
    });
    expect(onError).toHaveBeenCalledWith("verification_required");
    expect(outOfBandContinuation).not.toHaveBeenCalled();
    expect(harness.persistSession).not.toHaveBeenCalled();
  });

  it("reports an unverified email distinctly from a generic exchange failure", async () => {
    const error = deferred<void>();
    const onError = vi.fn(() => error.resolve());
    const harness = setup({
      onError,
      client: {
        exchangeCode: vi.fn(async () => {
          throw Object.assign(new Error("unverified"), {
            code: "user_email_unverified",
          });
        }),
      },
    });
    await harness.flow.start();

    expect(
      harness.flow.acceptCallback({
        state: callbackState(harness.openedUrl!),
        code: "real-code",
      }),
    ).toBe(true);
    await error.promise;

    expect(onError).toHaveBeenCalledWith("email_unverified");
  });

  it("surfaces reviewed account recovery with its non-secret support locator", async () => {
    const error = deferred<void>();
    const onError = vi.fn(() => error.resolve());
    const harness = setup({
      onError,
      resolveAccountId: async () => {
        throw Object.assign(new Error("recovery required"), {
          code: "account_recovery_required",
          status: 409,
          recoveryCode: "ZR-ABCD-2345",
        });
      },
    });
    await harness.flow.start();

    expect(
      harness.flow.acceptCallback({
        state: callbackState(harness.openedUrl!),
        code: "real-code",
      }),
    ).toBe(true);
    await error.promise;

    expect(onError).toHaveBeenCalledWith("account_recovery_required", {
      recoveryCode: "ZR-ABCD-2345",
    });
    expect(harness.persistSession).not.toHaveBeenCalled();
    expect(harness.revokeSession).toHaveBeenCalledWith(session.accessToken);
  });

  it("still reports an unnamed exchange failure as the generic reason", async () => {
    const error = deferred<void>();
    const onError = vi.fn(() => error.resolve());
    const harness = setup({
      onError,
      client: {
        exchangeCode: vi.fn(async () => {
          throw new Error("network down");
        }),
      },
    });
    await harness.flow.start();

    expect(
      harness.flow.acceptCallback({
        state: callbackState(harness.openedUrl!),
        code: "real-code",
      }),
    ).toBe(true);
    await error.promise;

    expect(onError).toHaveBeenCalledWith("exchange_failed");
  });

  it("cancellation prevents a late callback from installing a session", async () => {
    const harness = setup();
    await harness.flow.start();
    const state = callbackState(harness.openedUrl!);

    expect(harness.flow.cancel()).toBe(true);
    expect(
      harness.flow.acceptCallback({ state, code: "authorization-code" }),
    ).toBe(false);
    expect(harness.exchangeCode).not.toHaveBeenCalled();
    expect(harness.persistSession).not.toHaveBeenCalled();
  });

  it("expires the callback window and rejects a callback that arrives later", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_800_000_000_000);
    try {
      const error = deferred<void>();
      const onError = vi.fn(() => error.resolve());
      const harness = setup({ onError, timeoutMs: 10 * 60_000 });
      const attempt = await harness.flow.start();
      const state = callbackState(harness.openedUrl!);

      expect(attempt.expiresAt).toBe(1_800_000_600_000);
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      await error.promise;

      expect(onError).toHaveBeenCalledOnce();
      expect(onError).toHaveBeenCalledWith("expired");
      expect(
        harness.flow.acceptCallback({ state, code: "late-code" }),
      ).toBe(false);
      expect(harness.exchangeCode).not.toHaveBeenCalled();
      expect(harness.persistSession).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a replacement attempt valid when the old browser returns late", async () => {
    const harness = setup();
    await harness.flow.start();
    const replacedState = callbackState(harness.openedUrl!);

    await harness.flow.start();
    const currentState = callbackState(harness.openedUrl!);
    expect(currentState).not.toBe(replacedState);
    expect(
      harness.flow.acceptCallback({
        state: replacedState,
        code: "replaced-attempt-code",
      }),
    ).toBe(false);
    expect(
      harness.flow.acceptCallback({
        state: currentState,
        code: "current-attempt-code",
      }),
    ).toBe(true);
    await harness.completed.promise;

    expect(harness.exchangeCode).toHaveBeenCalledOnce();
    expect(harness.exchangeCode).toHaveBeenCalledWith({
      code: "current-attempt-code",
      codeVerifier: expect.any(String),
    });
  });

  it("revokes a provider session abandoned after code exchange", async () => {
    const exchanged = deferred<WorkOSDesktopSession>();
    const harness = setup({
      client: {
        exchangeCode: () => exchanged.promise,
      },
    });
    await harness.flow.start();
    harness.flow.acceptCallback({
      state: callbackState(harness.openedUrl!),
      code: "authorization-code",
    });
    harness.flow.cancel();
    exchanged.resolve(session);

    await vi.waitFor(() =>
      expect(harness.revokeSession).toHaveBeenCalledWith(session.accessToken),
    );
    expect(harness.persistSession).not.toHaveBeenCalled();
  });

  it("revokes a new provider session when account resolution fails", async () => {
    const error = deferred<void>();
    const harness = setup({
      resolveAccountId: async () => {
        throw new Error("control plane unavailable");
      },
      onError: () => error.resolve(),
    });
    await harness.flow.start();
    harness.flow.acceptCallback({
      state: callbackState(harness.openedUrl!),
      code: "authorization-code",
    });
    await error.promise;

    expect(harness.revokeSession).toHaveBeenCalledWith(session.accessToken);
    expect(harness.persistSession).not.toHaveBeenCalled();
  });
});
