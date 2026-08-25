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
  let authorizationOptions:
    | { state: string; codeChallenge: string; redirectUri: string }
    | undefined;
  const exchangeCode = vi.fn(async () => session);
  const persistSession = vi.fn();
  const revokeSession = vi.fn(async () => {});
  const deps: WorkOSDesktopAuthorizationFlowDeps = {
    client: {
      authorizationUrl(options) {
        authorizationOptions = options;
        const url = new URL("https://api.workos.com/user_management/authorize");
        for (const [key, value] of Object.entries({
          state: options.state,
          redirect_uri: options.redirectUri,
          code_challenge: options.codeChallenge,
        })) {
          url.searchParams.set(key, value);
        }
        return url.toString();
      },
      exchangeCode,
    },
    openExternal: async () => {},
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
    get authorizationOptions() {
      return authorizationOptions;
    },
  };
}

afterEach(() => {
  for (const flow of controllers.splice(0)) flow.cancel();
});

describe("WorkOS desktop loopback authorization", () => {
  it("binds the loopback callback before opening the browser and consumes it once", async () => {
    const completed = deferred<void>();
    let callbackStatus = 0;
    const harness = setup({
      async openExternal(url) {
        const authorize = new URL(url);
        const callback = new URL(authorize.searchParams.get("redirect_uri")!);
        callback.searchParams.set(
          "state",
          authorize.searchParams.get("state")!,
        );
        callback.searchParams.set("code", "authorization-code");
        const response = await fetch(callback);
        callbackStatus = response.status;
      },
      onComplete: () => completed.resolve(),
    });

    await harness.flow.start();
    await completed.promise;

    expect(callbackStatus).toBe(200);
    expect(harness.exchangeCode).toHaveBeenCalledWith({
      code: "authorization-code",
      codeVerifier: expect.any(String),
    });
    expect(harness.persistSession).toHaveBeenCalledWith({
      ...session,
      accountId: "00000000-0000-4000-8000-000000000001",
    });
    await expect(
      fetch(harness.authorizationOptions!.redirectUri),
    ).rejects.toThrow();
  });

  it("rejects a mismatched state without consuming the legitimate callback", async () => {
    const completed = deferred<void>();
    const statuses: number[] = [];
    const harness = setup({
      async openExternal(url) {
        const authorize = new URL(url);
        const redirect = authorize.searchParams.get("redirect_uri")!;
        const bad = new URL(redirect);
        bad.searchParams.set("state", "attacker-state");
        bad.searchParams.set("code", "attacker-code");
        statuses.push((await fetch(bad)).status);

        const good = new URL(redirect);
        good.searchParams.set("state", authorize.searchParams.get("state")!);
        good.searchParams.set("code", "real-code");
        statuses.push((await fetch(good)).status);
      },
      onComplete: () => completed.resolve(),
    });

    await harness.flow.start();
    await completed.promise;

    expect(statuses).toEqual([400, 200]);
    expect(harness.exchangeCode).toHaveBeenCalledTimes(1);
    expect(harness.exchangeCode).toHaveBeenCalledWith({
      code: "real-code",
      codeVerifier: expect.any(String),
    });
  });

  it("cancellation closes the listener and prevents a late session install", async () => {
    const harness = setup();
    await harness.flow.start();
    const redirectUri = harness.authorizationOptions!.redirectUri;

    expect(harness.flow.cancel()).toBe(true);
    await expect(fetch(redirectUri)).rejects.toThrow();
    expect(harness.exchangeCode).not.toHaveBeenCalled();
    expect(harness.persistSession).not.toHaveBeenCalled();
  });

  it("revokes a provider session abandoned after code exchange", async () => {
    const exchanged = deferred<WorkOSDesktopSession>();
    const harness = setup({
      client: {
        authorizationUrl(options) {
          const url = new URL(
            "https://api.workos.com/user_management/authorize",
          );
          url.searchParams.set("state", options.state);
          url.searchParams.set("redirect_uri", options.redirectUri);
          url.searchParams.set("code_challenge", options.codeChallenge);
          return url.toString();
        },
        exchangeCode: () => exchanged.promise,
      },
      async openExternal(url) {
        const authorize = new URL(url);
        const callback = new URL(authorize.searchParams.get("redirect_uri")!);
        callback.searchParams.set(
          "state",
          authorize.searchParams.get("state")!,
        );
        callback.searchParams.set("code", "authorization-code");
        await fetch(callback);
      },
    });

    await harness.flow.start();
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
      async openExternal(url) {
        const authorize = new URL(url);
        const callback = new URL(authorize.searchParams.get("redirect_uri")!);
        callback.searchParams.set(
          "state",
          authorize.searchParams.get("state")!,
        );
        callback.searchParams.set("code", "authorization-code");
        await fetch(callback);
      },
      onError: () => error.resolve(),
    });

    await harness.flow.start();
    await error.promise;

    expect(harness.revokeSession).toHaveBeenCalledWith(session.accessToken);
    expect(harness.persistSession).not.toHaveBeenCalled();
  });
});
