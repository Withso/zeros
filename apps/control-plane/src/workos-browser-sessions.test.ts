import { describe, expect, it, vi } from "vitest";

import {
  WORKOS_FLOW_COOKIE,
  WORKOS_HANDOFF_COOKIE,
  WORKOS_SESSION_COOKIE,
  WorkOSBrowserSessions,
  createWorkOSBrowserSessionRoutes,
  type LockedWorkOSSession,
  type WorkOSBrowserSessionRepository,
  type WorkOSFlowRecord,
  type WorkOSSessionRecord,
} from "./workos-browser-sessions.js";
import {
  WorkOSAuthenticationRequiredError,
  type WorkOSBrowserProvider,
  type WorkOSExchange,
  type WorkOSRefreshResult,
  type WorkOSRestoreResult,
} from "./workos-provider.js";

const START = 1_800_000_000_000;
const ACTIVE_UNTIL = START + 5 * 60_000;
const APP_ORIGIN = "https://app-alpha.zeros.build";
const TOKENS = ["A".repeat(43), "B".repeat(43), "C".repeat(43)];

function clone<T>(value: T): T {
  return structuredClone(value);
}

class MemoryRepository implements WorkOSBrowserSessionRepository {
  flow: {
    credentialHash: Buffer;
    stateHash: Buffer;
    record: WorkOSFlowRecord;
    claimed: boolean;
  } | null = null;
  session: WorkOSSessionRecord | null = null;
  writes = 0;
  locks = 0;
  private lockTail: Promise<void> = Promise.resolve();

  async createFlow(
    credentialHash: Buffer,
    stateHash: Buffer,
    record: WorkOSFlowRecord,
  ): Promise<void> {
    this.flow = {
      credentialHash: Buffer.from(credentialHash),
      stateHash: Buffer.from(stateHash),
      record: clone(record),
      claimed: false,
    };
  }

  async claimFlow(
    credentialHash: Buffer,
    stateHash: Buffer,
    now: number,
  ): Promise<WorkOSFlowRecord | null> {
    if (
      !this.flow ||
      this.flow.claimed ||
      this.flow.record.expiresAt <= now ||
      !this.flow.credentialHash.equals(credentialHash) ||
      !this.flow.stateHash.equals(stateHash)
    ) {
      return null;
    }
    this.flow.claimed = true;
    return clone(this.flow.record);
  }

  async promoteFlow(
    credentialHash: Buffer,
    record: WorkOSSessionRecord,
  ): Promise<"promoted" | "missing"> {
    if (
      !this.flow?.claimed ||
      !this.flow.credentialHash.equals(credentialHash)
    ) {
      return "missing";
    }
    this.flow = null;
    this.session = clone(record);
    this.writes += 1;
    return "promoted";
  }

  async deleteFlow(credentialHash: Buffer): Promise<void> {
    if (this.flow?.credentialHash.equals(credentialHash)) this.flow = null;
  }

  async readSession(
    _credentialHash: Buffer,
  ): Promise<WorkOSSessionRecord | null> {
    return this.session ? clone(this.session) : null;
  }

  async withLockedSession<T>(
    _credentialHash: Buffer,
    operation: (session: LockedWorkOSSession) => Promise<T>,
  ): Promise<T> {
    this.locks += 1;
    const previous = this.lockTail;
    let release = () => {};
    this.lockTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation({
        record: this.session ? clone(this.session) : null,
        replace: async (record) => {
          this.session = clone(record);
          this.writes += 1;
        },
        delete: async () => {
          this.session = null;
        },
      });
    } finally {
      release();
    }
  }
}

function exchange(overrides: Partial<WorkOSExchange> = {}): WorkOSExchange {
  return {
    sealedSession: "sealed-session-1",
    sessionId: "session_01TEST",
    accessToken: "signed-access-token-1",
    accessTokenExpiresAt: ACTIVE_UNTIL,
    user: {
      id: "user_01TEST",
      email: "verified@example.com",
      emailVerified: true,
      name: "Verified User",
    },
    ...overrides,
  };
}

function provider(
  overrides: Partial<WorkOSBrowserProvider> = {},
): WorkOSBrowserProvider {
  return {
    authorizationUrl({ state, codeChallenge }) {
      return `https://api.workos.test/authorize?state=${state}&code_challenge=${codeChallenge}`;
    },
    async exchange() {
      return exchange();
    },
    async restore(sealedSession): Promise<WorkOSRestoreResult> {
      return { status: "active", ...exchange({ sealedSession }) };
    },
    async refresh(): Promise<WorkOSRefreshResult> {
      return { status: "terminal", reason: "invalid_grant" };
    },
    logoutUrl({ sessionId, returnTo }) {
      return `https://api.workos.test/logout?session_id=${sessionId}&return_to=${encodeURIComponent(returnTo)}`;
    },
    async revokeSession() {},
    ...overrides,
  };
}

function subject(
  options: {
    repository?: MemoryRepository;
    provider?: WorkOSBrowserProvider;
    now?: () => number;
  } = {},
) {
  const repository = options.repository ?? new MemoryRepository();
  let tokenIndex = 0;
  return {
    repository,
    sessions: new WorkOSBrowserSessions(
      repository,
      options.provider ?? provider(),
      APP_ORIGIN,
      options.now ?? (() => START),
      () => TOKENS[tokenIndex++] ?? "D".repeat(43),
    ),
  };
}

async function beginAndComplete(
  value: ReturnType<typeof subject>,
): Promise<void> {
  const started = await value.sessions.start({
    returnPath: "/after",
  });
  const state = new URL(started.authorizationUrl).searchParams.get("state")!;
  expect(
    await value.sessions.complete({
      credential: started.credential,
      code: "one-time-code",
      state,
    }),
  ).toEqual({ ok: true, returnPath: "/after" });
}

describe("Railway WorkOS browser-session coordinator", () => {
  it("keeps PKCE material server-side and completes on a same-site document", async () => {
    const value = subject();
    const app = createWorkOSBrowserSessionRoutes(value.sessions, APP_ORIGIN);
    const started = await app.request(
      `/auth/start?return=${encodeURIComponent(`${APP_ORIGIN}/after?one=1&two=2`)}`,
    );
    expect(started.status).toBe(303);
    expect(started.headers.get("location")).toMatch(
      /^https:\/\/api\.workos\.test\/authorize\?/,
    );
    const flowCookie = started.headers
      .getSetCookie()
      .find((cookie) => cookie.startsWith(`${WORKOS_FLOW_COOKIE}=`));
    expect(flowCookie).toContain(`${WORKOS_FLOW_COOKIE}=${TOKENS[0]}`);
    expect(flowCookie).toContain("Secure");
    expect(flowCookie).toContain("HttpOnly");
    expect(flowCookie).toContain("SameSite=Lax");
    expect(flowCookie).not.toContain("Domain=");
    expect(flowCookie).not.toContain(TOKENS[1]);
    expect(flowCookie).not.toContain(TOKENS[2]);

    const state = new URL(started.headers.get("location")!).searchParams.get(
      "state",
    )!;
    const completed = await app.request(
      `/auth/callback?code=one-time-code&state=${encodeURIComponent(state)}`,
      { headers: { cookie: `${WORKOS_FLOW_COOKIE}=${TOKENS[0]}` } },
    );
    expect(completed.status).toBe(200);
    expect(completed.headers.get("location")).toBeNull();
    expect(completed.headers.get("referrer-policy")).toBe("no-referrer");
    const completionDocument = await completed.text();
    expect(completionDocument).toContain(
      `<meta http-equiv="refresh" content="0;url=${APP_ORIGIN}/after?one=1&amp;two=2" />`,
    );
    expect(completionDocument).toContain(
      `href="${APP_ORIGIN}/after?one=1&amp;two=2"`,
    );
    expect(completionDocument).not.toContain("?one=1&two=2");
    expect(completionDocument).toContain('<div class="title">Completing sign in</div>');
    expect(completionDocument).toContain(
      '<div class="sub">Your secure Zeros session is ready. Continue to open the app.</div>',
    );
    expect(completionDocument).toContain(
      `<div class="acts"><a class="btn" href="${APP_ORIGIN}/after?one=1&amp;two=2">Continue to Zeros</a></div>`,
    );
    expect(completed.headers.get("content-security-policy")).toMatch(
      /style-src 'sha256-[A-Za-z0-9+/]+=*'/,
    );
    const setCookies = completed.headers.getSetCookie();
    const sessionCookie = setCookies.find((cookie) =>
      cookie.startsWith(`${WORKOS_SESSION_COOKIE}=`),
    );
    expect(sessionCookie).toContain("SameSite=Strict");
    const cookies = setCookies.join("\n");
    expect(cookies).toContain(`${WORKOS_SESSION_COOKIE}=${TOKENS[0]}`);
    expect(cookies).toContain(`${WORKOS_FLOW_COOKIE}=;`);
    expect(cookies).not.toContain("one-time-code");
    expect(cookies).not.toContain(state);
  });

  it("forwards only an exact Google or GitHub choice, never a connection or organization", async () => {
    const authorizationUrl = vi.fn(
      ({ state, codeChallenge }: { state: string; codeChallenge: string }) =>
        `https://api.workos.test/authorize?state=${state}&code_challenge=${codeChallenge}`,
    );
    const value = subject({ provider: provider({ authorizationUrl }) });
    const app = createWorkOSBrowserSessionRoutes(value.sessions, APP_ORIGIN, {
      socialProviders: true,
    });

    const paths = [
      "/auth/start?provider=github&connection=conn_attacker&organization=org_attacker",
      "/auth/start?provider=google",
      "/auth/start?provider=GitHubOAuth",
      "/auth/start?provider=authkit",
      "/auth/start?provider=sso",
      "/auth/start?provider=google&provider=github",
      "/auth/start",
    ];
    for (const path of paths) {
      expect((await app.request(path)).status).toBe(303);
    }

    const options = authorizationUrl.mock.calls.map((call) => call[0] as Record<string, unknown>);
    expect(options.map((option) => option.socialProvider)).toEqual([
      "github",
      "google",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
    for (const option of options) {
      expect(option).not.toHaveProperty("provider");
      expect(option).not.toHaveProperty("connection");
      expect(option).not.toHaveProperty("organization");
    }
  });

  it("keeps routes without social providers, such as Ops, on Hosted AuthKit", async () => {
    const authorizationUrl = vi.fn(
      ({ state, codeChallenge }: { state: string; codeChallenge: string }) =>
        `https://api.workos.test/authorize?state=${state}&code_challenge=${codeChallenge}`,
    );
    const value = subject({ provider: provider({ authorizationUrl }) });
    const app = createWorkOSBrowserSessionRoutes(value.sessions, APP_ORIGIN);

    const response = await app.request("/auth/start?provider=github&max_age=300");

    expect(response.status).toBe(303);
    expect(authorizationUrl.mock.calls[0]?.[0]).not.toHaveProperty("socialProvider");
    expect(authorizationUrl.mock.calls[0]?.[0]).toMatchObject({ maxAge: 300 });
  });

  it("ends a failed callback on the shared page with the reason and Try again", async () => {
    const value = subject();
    const app = createWorkOSBrowserSessionRoutes(value.sessions, APP_ORIGIN);

    const missing = await app.request("/auth/callback?state=only-state");
    const denied = await app.request("/auth/callback?error=access_denied");

    expect(missing.status).toBe(400);
    expect(missing.headers.get("content-type")).toMatch(/^text\/html/);
    expect(missing.headers.get("cache-control")).toBe("no-store");
    expect(missing.headers.get("content-security-policy")).toMatch(/default-src 'none'/);
    const page = await missing.text();
    expect(page).toContain('<div class="title">Sign-in didn’t finish</div>');
    expect(page).toContain(
      '<div class="sub">The sign-in response was incomplete. Nothing was changed.</div>',
    );
    expect(page).toContain('<div class="acts"><a class="btn" href="/">Try again</a></div>');
    expect(await denied.text()).toContain(
      '<div class="sub">The identity provider didn’t finish. Nothing was changed.</div>',
    );
  });

  it("forwards only the fixed five-minute step-up request", async () => {
    const authorizationUrl = vi.fn(
      ({ state, codeChallenge }: { state: string; codeChallenge: string }) =>
        `https://api.workos.test/authorize?state=${state}&code_challenge=${codeChallenge}`,
    );
    const value = subject({ provider: provider({ authorizationUrl }) });
    const app = createWorkOSBrowserSessionRoutes(value.sessions, APP_ORIGIN);

    expect((await app.request("/auth/start?max_age=300")).status).toBe(303);
    expect(authorizationUrl.mock.calls[0]?.[0]).toMatchObject({ maxAge: 300 });

    expect((await app.request("/auth/start?max_age=86400")).status).toBe(303);
    expect(authorizationUrl.mock.calls[1]?.[0]).not.toHaveProperty("maxAge");
  });

  it("stores only hashes of the opaque browser credential and OAuth state", async () => {
    const value = subject();
    const started = await value.sessions.start({
      returnPath: `${APP_ORIGIN}/invite?token=safe`,
    });
    const state = new URL(started.authorizationUrl).searchParams.get("state")!;

    expect(started.credential).toBe(TOKENS[0]);
    expect(value.repository.flow?.credentialHash).toHaveLength(32);
    expect(value.repository.flow?.stateHash).toHaveLength(32);
    const serialized = JSON.stringify(value.repository.flow);
    expect(serialized).not.toContain(started.credential);
    expect(serialized).not.toContain(state);
    expect(value.repository.flow?.record.returnPath).toBe("/invite?token=safe");
  });

  it("serves a healthy bearer without taking the cross-replica refresh lock", async () => {
    const value = subject();
    await beginAndComplete(value);
    const locksBefore = value.repository.locks;

    const result = await value.sessions.session(TOKENS[0]);

    expect(result.status).toBe("active");
    expect(value.repository.locks).toBe(locksBefore);
  });

  it("claims exact callback state once before exchanging the code", async () => {
    let exchanges = 0;
    const value = subject({
      provider: provider({
        async exchange() {
          exchanges += 1;
          return exchange();
        },
      }),
    });
    const started = await value.sessions.start({
      returnPath: "/after",
    });
    const state = new URL(started.authorizationUrl).searchParams.get("state")!;

    await expect(
      value.sessions.complete({
        credential: started.credential,
        code: "code",
        state: "wrong",
      }),
    ).resolves.toEqual({ ok: false, reason: "invalid_flow" });
    expect(exchanges).toBe(0);
    expect(
      await value.sessions.complete({
        credential: started.credential,
        code: "code",
        state,
      }),
    ).toEqual({ ok: true, returnPath: "/after" });
    expect(
      await value.sessions.complete({
        credential: started.credential,
        code: "replay",
        state,
      }),
    ).toEqual({ ok: false, reason: "invalid_flow" });
    expect(exchanges).toBe(1);
  });

  it("rejects an unverified email and revokes the provider session", async () => {
    const revoked: string[] = [];
    const value = subject({
      provider: provider({
        async exchange() {
          return exchange({
            user: { ...exchange().user, emailVerified: false },
          });
        },
        async revokeSession(sessionId) {
          revoked.push(sessionId);
        },
      }),
    });
    const started = await value.sessions.start({
      returnPath: "/",
    });
    const state = new URL(started.authorizationUrl).searchParams.get("state")!;

    expect(
      await value.sessions.complete({
        credential: started.credential,
        code: "code",
        state,
      }),
    ).toEqual({ ok: false, reason: "email_unverified" });
    expect(value.repository.session).toBeNull();
    expect(revoked).toEqual(["session_01TEST"]);
  });

  it("hands a multi-organization social sign-in to Hosted AuthKit once, keeping the return path", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const authorizationUrl = vi.fn(
        ({ state, codeChallenge }: { state: string; codeChallenge: string }) =>
          `https://api.workos.test/authorize?state=${state}&code_challenge=${codeChallenge}`,
      );
      const exchangeCode = vi.fn(async (): Promise<WorkOSExchange> => {
        throw new WorkOSAuthenticationRequiredError(
          "organization_selection_required",
          403,
          "req_handoff",
        );
      });
      const value = subject({
        provider: provider({ authorizationUrl, exchange: exchangeCode }),
      });
      const app = createWorkOSBrowserSessionRoutes(value.sessions, APP_ORIGIN, {
        socialProviders: true,
      });

      const started = await app.request(
        `/auth/start?provider=github&return=${encodeURIComponent("/dashboard")}`,
      );
      expect(started.headers.getSetCookie().join("\n")).toContain(
        `${WORKOS_HANDOFF_COOKIE}=;`,
      );
      const firstState = new URL(
        started.headers.get("location")!,
      ).searchParams.get("state")!;
      const handedOff = await app.request(
        `/auth/callback?code=one-time-code&state=${encodeURIComponent(firstState)}`,
        { headers: { cookie: `${WORKOS_FLOW_COOKIE}=${TOKENS[0]}` } },
      );

      expect(handedOff.status).toBe(303);
      expect(handedOff.headers.get("cache-control")).toBe("no-store");
      expect(authorizationUrl.mock.calls.map((call) => call[0].socialProvider)).toEqual([
        "github",
        undefined,
      ]);
      const hostedUrl = new URL(handedOff.headers.get("location")!);
      const hostedState = hostedUrl.searchParams.get("state")!;
      expect(hostedState).not.toBe(firstState);
      const handoffCookies = handedOff.headers.getSetCookie();
      const flowCookies = handoffCookies.filter((cookie) =>
        cookie.startsWith(`${WORKOS_FLOW_COOKIE}=`),
      );
      expect(flowCookies).toHaveLength(1);
      // Each start draws credential, state and verifier; this is the second start.
      const hostedCredential = "D".repeat(43);
      expect(flowCookies[0]).toContain(`${WORKOS_FLOW_COOKIE}=${hostedCredential};`);
      expect(flowCookies[0]).toContain("SameSite=Lax");
      const handoffCookie = handoffCookies.find((cookie) =>
        cookie.startsWith(`${WORKOS_HANDOFF_COOKIE}=`),
      );
      expect(handoffCookie).toContain(`${WORKOS_HANDOFF_COOKIE}=1;`);
      expect(handoffCookie).toContain("HttpOnly");
      expect(handoffCookie).toContain("Secure");
      expect(value.repository.flow?.record.returnPath).toBe("/dashboard");
      expect(value.repository.session).toBeNull();
      const logged = JSON.stringify(warn.mock.calls);
      expect(logged).toContain("organization_selection_required");
      expect(logged).toContain("req_handoff");
      expect(logged).not.toContain("one-time-code");
      expect(logged).not.toContain(firstState);

      // A second ceremony from the hosted flow ends on the page, never a loop.
      const repeated = await app.request(
        `/auth/callback?code=hosted-code&state=${encodeURIComponent(hostedState)}`,
        {
          headers: {
            cookie: `${WORKOS_FLOW_COOKIE}=${hostedCredential}; ${WORKOS_HANDOFF_COOKIE}=1`,
          },
        },
      );
      expect(repeated.status).toBe(400);
      expect(await repeated.text()).toContain(
        '<div class="sub">This account needs a step the sign-in page couldn’t finish. Nothing was changed.</div>',
      );
      const repeatedCookies = repeated.headers.getSetCookie().join("\n");
      expect(repeatedCookies).toContain(`${WORKOS_FLOW_COOKIE}=;`);
      expect(repeatedCookies).toContain(`${WORKOS_HANDOFF_COOKIE}=;`);
      expect(authorizationUrl).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
    }
  });

  it("finishes the hosted hand-off normally and clears its marker", async () => {
    const value = subject();
    const app = createWorkOSBrowserSessionRoutes(value.sessions, APP_ORIGIN, {
      socialProviders: true,
    });
    const started = await app.request("/auth/start");
    const state = new URL(started.headers.get("location")!).searchParams.get(
      "state",
    )!;

    const completed = await app.request(
      `/auth/callback?code=hosted-code&state=${encodeURIComponent(state)}`,
      {
        headers: {
          cookie: `${WORKOS_FLOW_COOKIE}=${TOKENS[0]}; ${WORKOS_HANDOFF_COOKIE}=1`,
        },
      },
    );

    expect(completed.status).toBe(200);
    expect(completed.headers.getSetCookie().join("\n")).toContain(
      `${WORKOS_HANDOFF_COOKIE}=;`,
    );
    expect(value.repository.session).not.toBeNull();
  });

  it("maps a provider email-verification ceremony to the verify-email page", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const value = subject({
        provider: provider({
          async exchange() {
            throw new WorkOSAuthenticationRequiredError(
              "email_verification_required",
              403,
              "req_verify",
            );
          },
        }),
      });
      const started = await value.sessions.start({ returnPath: "/" });
      const state = new URL(started.authorizationUrl).searchParams.get("state")!;

      expect(
        await value.sessions.complete({
          credential: started.credential,
          code: "code",
          state,
        }),
      ).toEqual({ ok: false, reason: "email_unverified" });
      expect(value.repository.flow).toBeNull();
    } finally {
      warn.mockRestore();
    }
  });

  it("logs a failed code exchange by class and status only", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const value = subject({
        provider: provider({
          async exchange() {
            throw Object.assign(new Error("secret-bearing provider message"), {
              status: 400,
              requestID: "req_failed",
            });
          },
        }),
      });
      const started = await value.sessions.start({ returnPath: "/" });
      const state = new URL(started.authorizationUrl).searchParams.get("state")!;

      expect(
        await value.sessions.complete({
          credential: started.credential,
          code: "code",
          state,
        }),
      ).toEqual({ ok: false, reason: "exchange_failed" });
      const logged = JSON.stringify(warn.mock.calls);
      expect(logged).toContain("req_failed");
      expect(logged).toContain("400");
      expect(logged).not.toContain("secret-bearing");
    } finally {
      warn.mockRestore();
    }
  });

  it("serializes near-expiry refreshes across coordinator instances", async () => {
    let now = START;
    let refreshes = 0;
    let current = exchange();
    const auth = provider({
      async refresh() {
        refreshes += 1;
        await new Promise((resolve) => setImmediate(resolve));
        current = exchange({
          sealedSession: "sealed-session-2",
          accessToken: "signed-access-token-2",
          accessTokenExpiresAt: ACTIVE_UNTIL + 5 * 60_000,
        });
        return { status: "active", ...current };
      },
      async restore(sealedSession) {
        return { status: "active", ...current, sealedSession };
      },
    });
    const value = subject({ provider: auth, now: () => now });
    await beginAndComplete(value);
    now = ACTIVE_UNTIL;

    const [first, second] = await Promise.all([
      value.sessions.session(TOKENS[0]),
      value.sessions.session(TOKENS[0]),
    ]);

    expect(first.status).toBe("active");
    expect(second.status).toBe("active");
    expect(refreshes).toBe(1);
    expect(value.repository.session?.sealedSession).toBe("sealed-session-2");
    expect(value.repository.session?.revision).toBe(2);
  });

  it("uses the observed revision to collapse concurrent forced refreshes", async () => {
    let refreshes = 0;
    let current = exchange();
    const value = subject({
      provider: provider({
        async refresh() {
          refreshes += 1;
          current = exchange({
            sealedSession: "sealed-session-2",
            accessToken: "signed-access-token-2",
            accessTokenExpiresAt: ACTIVE_UNTIL + 5 * 60_000,
          });
          return { status: "active", ...current };
        },
        async restore(sealedSession) {
          return { status: "active", ...current, sealedSession };
        },
      }),
    });
    await beginAndComplete(value);

    const [first, second] = await Promise.all([
      value.sessions.session(TOKENS[0], {
        forceRefresh: true,
        expectedRevision: 1,
      }),
      value.sessions.session(TOKENS[0], {
        forceRefresh: true,
        expectedRevision: 1,
      }),
    ]);

    expect(first.status).toBe("active");
    expect(second.status).toBe("active");
    expect(refreshes).toBe(1);
  });

  it("persists a rotated seal after a transient verification failure", async () => {
    let now = START;
    const value = subject({
      now: () => now,
      provider: provider({
        async refresh() {
          return {
            status: "transient",
            reason: "verification_unavailable",
            sealedSession: "sealed-session-2",
          };
        },
      }),
    });
    await beginAndComplete(value);
    now = ACTIVE_UNTIL;

    const result = await value.sessions.session(TOKENS[0]);

    expect(result).toMatchObject({
      status: "transient",
      reason: "verification_unavailable",
      revision: 2,
    });
    expect(value.repository.session?.sealedSession).toBe("sealed-session-2");
    expect(value.repository.session?.revision).toBe(2);
  });

  it("deletes terminal sessions and local state before building logout URLs", async () => {
    const repository = new MemoryRepository();
    let deletedBeforeLogout = false;
    const value = subject({
      repository,
      provider: provider({
        logoutUrl({ returnTo }) {
          deletedBeforeLogout = repository.session === null;
          return `https://api.workos.test/logout?return_to=${encodeURIComponent(returnTo)}`;
        },
      }),
    });
    await beginAndComplete(value);

    expect(
      await value.sessions.logout(TOKENS[0], `${APP_ORIGIN}/after`),
    ).toEqual({
      logoutUrl: `https://api.workos.test/logout?return_to=${encodeURIComponent(`${APP_ORIGIN}/after`)}`,
    });
    expect(deletedBeforeLogout).toBe(true);

    await beginAndComplete(value);
    expect(
      await value.sessions.session(TOKENS[0], { forceRefresh: true }),
    ).toEqual({ status: "terminal", reason: "invalid_grant" });
    expect(repository.session).toBeNull();
  });
});
