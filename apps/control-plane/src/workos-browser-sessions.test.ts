import { describe, expect, it, vi } from "vitest";

import {
  WORKOS_FLOW_COOKIE,
  WORKOS_SESSION_COOKIE,
  WorkOSBrowserSessions,
  createWorkOSBrowserSessionRoutes,
  type LockedWorkOSSession,
  type WorkOSBrowserSessionRepository,
  type WorkOSFlowRecord,
  type WorkOSSessionRecord,
} from "./workos-browser-sessions.js";
import type {
  WorkOSBrowserProvider,
  WorkOSExchange,
  WorkOSRefreshResult,
  WorkOSRestoreResult,
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
  ): Promise<boolean> {
    if (
      !this.flow?.claimed ||
      !this.flow.credentialHash.equals(credentialHash)
    ) {
      return false;
    }
    this.flow = null;
    this.session = clone(record);
    this.writes += 1;
    return true;
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

  it("does not forward provider, connection, or organization selectors", async () => {
    const authorizationUrl = vi.fn(
      ({ state, codeChallenge }: { state: string; codeChallenge: string }) =>
        `https://api.workos.test/authorize?state=${state}&code_challenge=${codeChallenge}`,
    );
    const value = subject({ provider: provider({ authorizationUrl }) });
    const app = createWorkOSBrowserSessionRoutes(value.sessions, APP_ORIGIN);

    const response = await app.request(
      "/auth/start?provider=github&connection=conn_attacker&organization=org_attacker",
    );

    expect(response.status).toBe(303);
    expect(authorizationUrl).toHaveBeenCalledOnce();
    expect(authorizationUrl.mock.calls[0]?.[0]).not.toHaveProperty("provider");
    expect(authorizationUrl.mock.calls[0]?.[0]).not.toHaveProperty(
      "connection",
    );
    expect(authorizationUrl.mock.calls[0]?.[0]).not.toHaveProperty(
      "organization",
    );
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
