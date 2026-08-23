import {
  WORKOS_FLOW_TTL_S,
  WORKOS_SESSION_TTL_S,
} from "./workos-browser.mjs";

const REFRESH_SKEW_MS = 30_000;

function validString(value, max = 8_192) {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

function sessionData(exchange, now) {
  return {
    sub: exchange.user.id,
    email: exchange.user.email,
    name: typeof exchange.user.name === "string" && exchange.user.name ? exchange.user.name : null,
    accessToken: exchange.accessToken,
    refreshToken: null,
    verifiedAt: now,
  };
}

function validExchange(exchange, now) {
  return (
    exchange &&
    validString(exchange.sealedSession, 64 * 1_024) &&
    validString(exchange.sessionId, 512) &&
    validString(exchange.accessToken, 32 * 1_024) &&
    Number.isFinite(exchange.accessTokenExpiresAt) &&
    exchange.accessTokenExpiresAt > now &&
    exchange.user &&
    validString(exchange.user.id, 512) &&
    validString(exchange.user.email, 320) &&
    (exchange.user.name === null || typeof exchange.user.name === "string")
  );
}

export class WorkOSSessionCoordinator {
  constructor({ storage, provider, now = Date.now, randomToken, pkceChallenge }) {
    this.storage = storage;
    this.provider = provider;
    this.now = now;
    this.randomToken = randomToken;
    this.pkceChallenge = pkceChallenge;
    this.refreshInFlight = null;
  }

  async startFlow({ provider, returnPath, redirectUri }) {
    const now = this.now();
    const state = this.randomToken();
    const codeVerifier = this.randomToken();
    const codeChallenge = await this.pkceChallenge(codeVerifier);
    const expiresAt = now + WORKOS_FLOW_TTL_S * 1_000;
    const authorizationUrl = this.provider.authorizationUrl({
      provider,
      state,
      codeChallenge,
      redirectUri,
    });
    await this.storage.putRecord({
      kind: "flow",
      state,
      codeVerifier,
      returnPath,
      redirectUri,
      createdAt: now,
      expiresAt,
      claimedAt: null,
    });
    await this.storage.setExpiry(expiresAt);
    return { authorizationUrl };
  }

  async completeFlow({ code, state }) {
    const now = this.now();
    if (!validString(code) || !validString(state, 1_024)) {
      return { ok: false, reason: "invalid_flow" };
    }
    const flow = await this.storage.claimFlow(state, now);
    if (!flow) return { ok: false, reason: "invalid_flow" };

    let exchange;
    try {
      exchange = await this.provider.exchange({
        code,
        codeVerifier: flow.codeVerifier,
        redirectUri: flow.redirectUri,
      });
    } catch {
      return { ok: false, reason: "exchange_failed" };
    }
    if (!validExchange(exchange, now)) {
      await this.storage.deleteAll();
      return { ok: false, reason: "exchange_failed" };
    }
    if (exchange.user.emailVerified !== true) {
      await this.storage.deleteAll();
      return { ok: false, reason: "email_unverified" };
    }

    const expiresAt = now + WORKOS_SESSION_TTL_S * 1_000;
    const record = {
      kind: "session",
      sealedSession: exchange.sealedSession,
      sessionId: exchange.sessionId,
      accessTokenExpiresAt: exchange.accessTokenExpiresAt,
      sessionExpiresAt: expiresAt,
      revision: 1,
      data: sessionData(exchange, now),
    };
    await this.storage.putRecord(record);
    await this.storage.setExpiry(expiresAt);
    return { ok: true, returnPath: flow.returnPath };
  }

  async cancelFlow() {
    const record = await this.storage.getRecord();
    if (record?.kind === "flow") await this.storage.deleteAll();
  }

  async getSession() {
    const record = await this.storage.getRecord();
    if (!record || record.kind !== "session") return { status: "terminal", reason: "invalid_session" };
    const now = this.now();
    if (record.sessionExpiresAt <= now) {
      await this.storage.deleteAll();
      return { status: "terminal", reason: "session_expired" };
    }
    if (record.accessTokenExpiresAt > now + REFRESH_SKEW_MS) {
      return { status: "active", data: record.data };
    }
    return this.refreshSession();
  }

  refreshSession() {
    if (this.refreshInFlight) return this.refreshInFlight;
    const operation = this.performRefresh();
    const tracked = operation.finally(() => {
      if (this.refreshInFlight === tracked) this.refreshInFlight = null;
    });
    this.refreshInFlight = tracked;
    return tracked;
  }

  async performRefresh() {
    const record = await this.storage.getRecord();
    if (!record || record.kind !== "session") return { status: "terminal", reason: "invalid_session" };
    const now = this.now();
    if (record.sessionExpiresAt <= now) {
      await this.storage.deleteAll();
      return { status: "terminal", reason: "session_expired" };
    }

    let refreshed;
    try {
      refreshed = await this.provider.refresh({
        sealedSession: record.sealedSession,
      });
    } catch {
      return { status: "transient", reason: "unavailable", data: record.data };
    }
    if (refreshed?.status === "transient") {
      // A refresh grant can rotate successfully before a later, local JWT/JWKS
      // verification step fails. Retain that explicitly returned replacement
      // seal so the next attempt never reuses rotation state that WorkOS has
      // already consumed. Ordinary network/rate-limit failures provide no seal
      // and therefore leave the durable record byte-for-byte unchanged.
      if (
        validString(refreshed.sealedSession, 64 * 1_024) &&
        refreshed.sealedSession !== record.sealedSession
      ) {
        await this.storage.putRecord({
          ...record,
          sealedSession: refreshed.sealedSession,
          revision: record.revision + 1,
        });
      }
      return {
        status: "transient",
        reason: refreshed.reason || "unavailable",
        ...(Number.isFinite(refreshed.retryAfter) ? { retryAfter: refreshed.retryAfter } : {}),
        data: record.data,
      };
    }
    if (refreshed?.status === "terminal") {
      await this.storage.deleteAll();
      return { status: "terminal", reason: refreshed.reason || "invalid_grant" };
    }
    if (refreshed?.status !== "active" || !validExchange(refreshed, now)) {
      return { status: "transient", reason: "invalid_response", data: record.data };
    }
    if (refreshed.user.emailVerified !== true) {
      await this.storage.deleteAll();
      return { status: "terminal", reason: "email_unverified" };
    }

    const updated = {
      ...record,
      sealedSession: refreshed.sealedSession,
      sessionId: refreshed.sessionId,
      accessTokenExpiresAt: refreshed.accessTokenExpiresAt,
      revision: record.revision + 1,
      data: sessionData(refreshed, now),
    };
    // Persist every successful response. WorkOS production may return the same
    // refresh material, but that does not make the successful exchange a no-op.
    await this.storage.putRecord(updated);
    return { status: "active", data: updated.data };
  }

  async logout(returnTo) {
    const record = await this.storage.getRecord();
    await this.storage.deleteAll();
    if (!record || record.kind !== "session") return { logoutUrl: null };
    try {
      return {
        logoutUrl: this.provider.logoutUrl({
          sessionId: record.sessionId,
          returnTo,
        }),
      };
    } catch {
      return { logoutUrl: null };
    }
  }
}
