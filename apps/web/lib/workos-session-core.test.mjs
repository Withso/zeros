import assert from "node:assert/strict";
import test from "node:test";

import { WorkOSSessionCoordinator } from "./workos-session-core.mjs";

const START = 1_800_000_000_000;
const ACTIVE_UNTIL = START + 5 * 60_000;

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

class MemoryStorage {
  constructor() {
    this.record = null;
    this.puts = [];
    this.deleted = 0;
    this.expiries = [];
  }

  async getRecord() {
    return this.record ? structuredClone(this.record) : null;
  }

  async putRecord(record) {
    this.record = structuredClone(record);
    this.puts.push(structuredClone(record));
  }

  async claimFlow(state, now) {
    if (
      !this.record ||
      this.record.kind !== "flow" ||
      this.record.expiresAt <= now ||
      this.record.claimedAt ||
      this.record.state !== state
    ) {
      return null;
    }
    this.record.claimedAt = now;
    return structuredClone(this.record);
  }

  async deleteAll() {
    this.record = null;
    this.deleted += 1;
  }

  async setExpiry(epochMs) {
    this.expiries.push(epochMs);
  }
}

function trustedExchange(overrides = {}) {
  return {
    sealedSession: "sealed-session-1",
    sessionId: "session_01TEST",
    accessToken: "access-token-1",
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

function provider(overrides = {}) {
  return {
    authorizationUrl({ state, codeChallenge }) {
      return `https://api.workos.test/authorize?state=${state}&code_challenge=${codeChallenge}`;
    },
    async exchange() {
      return trustedExchange();
    },
    async refresh() {
      return { status: "terminal", reason: "invalid_grant" };
    },
    logoutUrl({ sessionId, returnTo }) {
      return `https://api.workos.test/logout?session_id=${sessionId}&return_to=${encodeURIComponent(returnTo)}`;
    },
    ...overrides,
  };
}

function coordinator({ storage = new MemoryStorage(), auth = provider(), now = () => START } = {}) {
  let tokenIndex = 0;
  const tokens = ["state-token", "pkce-verifier"];
  return {
    storage,
    coordinator: new WorkOSSessionCoordinator({
      storage,
      provider: auth,
      now,
      randomToken: () => tokens[tokenIndex++] ?? "extra-token",
      pkceChallenge: async () => "pkce-challenge",
    }),
  };
}

async function beginAndComplete(subject, exchange = trustedExchange()) {
  subject.coordinator.provider.exchange = async () => exchange;
  const started = await subject.coordinator.startFlow({
    provider: "GoogleOAuth",
    returnPath: "/after",
    redirectUri: "https://app-alpha.zeros.build/auth/callback",
  });
  const state = new URL(started.authorizationUrl).searchParams.get("state");
  const completed = await subject.coordinator.completeFlow({
    code: "one-time-code",
    state,
  });
  return { started, completed };
}

test("callback state is exact and each flow is consumed once", async () => {
  let exchanges = 0;
  const subject = coordinator({
    auth: provider({
      async exchange() {
        exchanges += 1;
        return trustedExchange();
      },
    }),
  });
  const started = await subject.coordinator.startFlow({
    provider: "GoogleOAuth",
    returnPath: "/after",
    redirectUri: "https://app-alpha.zeros.build/auth/callback",
  });
  const state = new URL(started.authorizationUrl).searchParams.get("state");

  assert.deepEqual(
    await subject.coordinator.completeFlow({ code: "code", state: "wrong" }),
    { ok: false, reason: "invalid_flow" },
  );
  assert.equal(exchanges, 0);
  assert.equal((await subject.coordinator.completeFlow({ code: "code", state })).ok, true);
  assert.deepEqual(
    await subject.coordinator.completeFlow({ code: "replay", state }),
    { ok: false, reason: "invalid_flow" },
  );
  assert.equal(exchanges, 1);
});

test("the trusted exchange User must have an explicitly verified email", async () => {
  const subject = coordinator();
  const result = await beginAndComplete(
    subject,
    trustedExchange({
      user: {
        id: "user_01TEST",
        email: "unverified@example.com",
        emailVerified: false,
        name: null,
      },
    }),
  );

  assert.deepEqual(result.completed, { ok: false, reason: "email_unverified" });
  assert.equal(subject.storage.record, null);
});

test("concurrent expired reads share one refresh and receive one durable rotation", async () => {
  const pending = deferred();
  let refreshes = 0;
  let currentTime = START;
  const subject = coordinator({
    auth: provider({
      async refresh() {
        refreshes += 1;
        return pending.promise;
      },
    }),
    now: () => currentTime,
  });
  await beginAndComplete(subject);
  currentTime = ACTIVE_UNTIL;
  const putsBefore = subject.storage.puts.length;

  const first = subject.coordinator.getSession();
  const second = subject.coordinator.getSession();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(refreshes, 1);

  pending.resolve({
    status: "active",
    sealedSession: "sealed-session-2",
    sessionId: "session_01TEST",
    accessToken: "access-token-2",
    accessTokenExpiresAt: ACTIVE_UNTIL + 5 * 60_000,
    user: trustedExchange().user,
  });
  const [a, b] = await Promise.all([first, second]);

  assert.equal(a.status, "active");
  assert.equal(b.status, "active");
  assert.equal(a.data.accessToken, "access-token-2");
  assert.equal(b.data.accessToken, "access-token-2");
  assert.equal(subject.storage.puts.length, putsBefore + 1);
  assert.equal(subject.storage.record.sealedSession, "sealed-session-2");
});

test("every successful refresh is persisted even when WorkOS returns unchanged state", async () => {
  let currentTime = START;
  const subject = coordinator({
    auth: provider({
      async refresh() {
        return {
          status: "active",
          ...trustedExchange(),
          accessTokenExpiresAt: ACTIVE_UNTIL + 5 * 60_000,
        };
      },
    }),
    now: () => currentTime,
  });
  await beginAndComplete(subject);
  currentTime = ACTIVE_UNTIL;
  const revision = subject.storage.record.revision;
  const putsBefore = subject.storage.puts.length;

  const result = await subject.coordinator.refreshSession();

  assert.equal(result.status, "active");
  assert.equal(subject.storage.puts.length, putsBefore + 1);
  assert.equal(subject.storage.record.revision, revision + 1);
  assert.equal(subject.storage.record.sealedSession, "sealed-session-1");
});

test("transient refresh failures preserve the exact durable session", async () => {
  let currentTime = START;
  const subject = coordinator({
    auth: provider({
      async refresh() {
        return { status: "transient", reason: "rate_limited", retryAfter: 2 };
      },
    }),
    now: () => currentTime,
  });
  await beginAndComplete(subject);
  currentTime = ACTIVE_UNTIL;
  const before = structuredClone(subject.storage.record);

  const result = await subject.coordinator.refreshSession();

  assert.deepEqual(result, {
    status: "transient",
    reason: "rate_limited",
    retryAfter: 2,
    data: before.data,
  });
  assert.deepEqual(subject.storage.record, before);
  assert.equal(subject.storage.deleted, 0);
});

test("a rotated seal survives a transient post-refresh verification failure", async () => {
  let currentTime = START;
  const subject = coordinator({
    auth: provider({
      async refresh() {
        return {
          status: "transient",
          reason: "verification_unavailable",
          sealedSession: "sealed-session-2",
        };
      },
    }),
    now: () => currentTime,
  });
  await beginAndComplete(subject);
  currentTime = ACTIVE_UNTIL;
  const before = structuredClone(subject.storage.record);
  const putsBefore = subject.storage.puts.length;

  const result = await subject.coordinator.refreshSession();

  assert.deepEqual(result, {
    status: "transient",
    reason: "verification_unavailable",
    data: before.data,
  });
  assert.equal(subject.storage.puts.length, putsBefore + 1);
  assert.equal(subject.storage.record.sealedSession, "sealed-session-2");
  assert.equal(subject.storage.record.revision, before.revision + 1);
  assert.deepEqual(subject.storage.record.data, before.data);
  assert.equal(subject.storage.deleted, 0);
});

test("terminal invalid_grant removes the server session", async () => {
  let currentTime = START;
  const subject = coordinator({ now: () => currentTime });
  await beginAndComplete(subject);
  currentTime = ACTIVE_UNTIL;

  assert.deepEqual(await subject.coordinator.refreshSession(), {
    status: "terminal",
    reason: "invalid_grant",
  });
  assert.equal(subject.storage.record, null);
  assert.equal(subject.storage.deleted, 1);
});

test("logout deletes local state before constructing the remote logout URL", async () => {
  const storage = new MemoryStorage();
  let observedDeleted = false;
  const subject = coordinator({
    storage,
    auth: provider({
      logoutUrl() {
        observedDeleted = storage.record === null;
        throw new Error("remote logout unavailable");
      },
    }),
  });
  await beginAndComplete(subject);

  const result = await subject.coordinator.logout("https://app-alpha.zeros.build/");

  assert.equal(observedDeleted, true);
  assert.deepEqual(result, { logoutUrl: null });
  assert.equal(storage.record, null);
});
