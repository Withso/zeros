import { describe, expect, it, vi } from "vitest";

import type {
  GithubAuthMethod,
  GithubCredential,
} from "@zeros/protocol/github-auth";

import {
  GithubAppClientError,
  type GithubAppTokenResult,
} from "../github-app-client";
import {
  GITHUB_APP_TRANSIENT_REFRESH_RETRY_MS,
  GITHUB_APP_UNAVAILABLE_REFRESH_RETRY_MS,
  GithubAppController,
  GithubAppFlowError,
  type GithubAppControllerDependencies,
  type PendingConsumeResult,
} from "../github-app-controller";

type AppCredential = Extract<GithubCredential, { method: "github-app" }>;

const gitIdentity = {
  gitHost: "github.com",
  gitHttpUsername: "x-access-token",
} as const;
const binding = (suffix: string) =>
  `zghrb_v1.${suffix.repeat(43)}.${suffix.toUpperCase().repeat(43)}`;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function harness(options?: {
  credential?: AppCredential | null;
  session?: { accessToken: string; sub: string } | null;
}) {
  let credential = options?.credential ?? null;
  let selected: GithubAuthMethod = "gh-cli";
  let pending: Parameters<GithubAppControllerDependencies["savePending"]>[0] | null = null;
  const events: Array<{ name: string; payload: unknown }> = [];
  const after = vi.fn();
  const afterTransientRefreshFailure = vi.fn();
  const exchangeResult: GithubAppTokenResult = {
    accessToken: "app-access-new",
    refreshToken: "app-refresh-new",
    refreshBinding: binding("a"),
    expiresAtMs: 10_000_000,
    refreshTokenExpiresAtMs: 20_000_000,
    login: "octocat",
    variantKey: "github.com",
    installationCount: 1,
    activeInstallationCount: 1,
    repositoryCount: 3,
    allRepositories: false,
  };
  const client = {
    start: vi.fn(async () => ({
      authorizeUrl: "https://github.com/apps/zeros/installations/new",
      expiresAtMs: 2_000_000,
      flowKind: "oauth" as const,
    })),
    exchange: vi.fn(async () => exchangeResult),
    refresh: vi.fn(async () => ({
      accessToken: "app-access-rotated",
      refreshToken: "app-refresh-rotated",
      refreshBinding: binding("b"),
      expiresAtMs: 11_000_000,
      refreshTokenExpiresAtMs: 21_000_000,
    })),
    revoke: vi.fn(async () => undefined),
    refreshInstallations: vi.fn(async () => ({
      login: "octocat",
      complete: true,
      installationCount: 1,
      activeInstallationCount: 1,
      repositoryCount: 7,
      allRepositories: false,
    })),
  };
  const deps: GithubAppControllerDependencies = {
    client,
    credentialStore: {
      get: async () => credential,
      set: async (_method, next) => {
        credential = { ...next };
      },
      clear: async () => {
        credential = null;
      },
      getSelectedMethod: async () => selected,
      setSelectedMethod: async (method) => {
        selected = method;
      },
    },
    compareAndSetCredential: async (expected, next) => {
      if (
        !credential ||
        credential.accessToken !== expected.accessToken ||
        credential.refreshToken !== expected.refreshToken
      ) {
        return false;
      }
      credential = next ? { ...next } : null;
      return true;
    },
    getSession: async () =>
      options?.session === undefined
        ? { accessToken: "zeros-access", sub: "auth0|one" }
        : options.session,
    savePending: (next) => {
      pending = next;
    },
    consumePending: (nonce): PendingConsumeResult => {
      if (!pending) return { status: "missing" };
      if (pending.expiresAtMs <= 1_000_000) {
        pending = null;
        return { status: "expired" };
      }
      if (pending.nonce !== nonce) return { status: "mismatch" };
      const preserveSelectedMethod = pending.preserveSelectedMethod;
      const ownerSub = pending.ownerSub;
      pending = null;
      return { status: "consumed", preserveSelectedMethod, ownerSub };
    },
    discardPending: (nonce) => {
      if (pending?.nonce === nonce) pending = null;
    },
    clearPending: () => {
      pending = null;
    },
    openExternal: vi.fn(async () => undefined),
    randomNonce: () => "n".repeat(43),
    withCredentialLock: async (operation) => operation(),
    afterCredentialChange: after,
    afterTransientRefreshFailure,
    emitConnected: (payload) => events.push({ name: "connected", payload }),
    emitError: (reason) => events.push({ name: "error", payload: { reason } }),
    now: () => 1_000_000,
  };
  return {
    after,
    afterTransientRefreshFailure,
    client,
    controller: new GithubAppController(deps),
    credential: () => credential,
    deps,
    events,
    pending: () => pending,
    selected: () => selected,
  };
}

describe("GitHub App desktop controller", () => {
  it("stores only a Dev reference, never exchanges or refreshes the old rotating pair",async()=>{
    const h=harness(),result={reference:{mode:'dev-reference' as const,bindingId:'11111111-1111-4111-8111-111111111111',connectionId:'22222222-2222-4222-8222-222222222222',
      generationId:'33333333-3333-4333-8333-333333333333',issuer:'https://identity.example.test',subject:'auth0|one',organization:'org_dev',accountId:'1234',appScope:'42:client_dev',backendOrigin:'https://api.example.test'},
      login:'octocat',variantKey:'github.com',installationCount:1};
    h.deps.devReference={exchange:vi.fn(async()=>result),save:vi.fn(async()=>{}),disconnect:vi.fn(async()=>true)};
    await h.controller.begin({scheme:'zeros-dev',installFlow:false});await h.controller.complete({nonce:'n'.repeat(43)});
    expect(h.deps.devReference.save).toHaveBeenCalledWith(result);expect(h.client.exchange).not.toHaveBeenCalled();
    expect(await h.controller.refresh({force:true})).toBeNull();expect(h.client.refresh).not.toHaveBeenCalled();expect(h.credential()).toBeNull();
    expect(h.events).toContainEqual({name:'connected',payload:{login:'octocat',installationCount:1}});
  });
  it("discards Dev reference completion if the WorkOS owner changes during exchange",async()=>{
    const h=harness();h.deps.devReference={exchange:vi.fn(async()=>{h.deps.getSession=async()=>({accessToken:'changed',sub:'user_other'});return {} as never;}),save:vi.fn(async()=>{}),disconnect:vi.fn(async()=>true)};
    await h.controller.begin({scheme:'zeros-dev',installFlow:false});await h.controller.complete({nonce:'n'.repeat(43)});
    expect(h.deps.devReference.save).not.toHaveBeenCalled();expect(h.client.exchange).not.toHaveBeenCalled();expect(h.events.some(e=>e.name==='connected')).toBe(false);
  });
  it.each(["disconnect", "account-change"])("does not publish a stale connected event after %s during credential delivery", async (change) => {
    const h = harness(), entered = deferred<void>(), delivery = deferred<void>();
    h.after.mockImplementationOnce(async () => { entered.resolve(); await delivery.promise; });
    await h.controller.begin({ scheme: "zeros-dev", installFlow: false });
    const completion = h.controller.complete({ nonce: "n".repeat(43) });
    await entered.promise;
    if (change === "disconnect") await h.controller.disconnect();
    else h.deps.getSession = async () => ({ accessToken: "different", sub: "auth0|two" });
    delivery.resolve(); await completion;
    expect(h.events.some(event => event.name === "connected")).toBe(false);
    if (change === "disconnect") expect(h.credential()).toBeNull();
  });

  it("keeps only the latest begin when the backend replies out of order", async () => {
    const h = harness();
    const older = deferred<Awaited<ReturnType<typeof h.client.start>>>();
    h.deps.randomNonce = vi.fn().mockReturnValueOnce("a".repeat(43)).mockReturnValueOnce("b".repeat(43));
    h.client.start.mockImplementationOnce(() => older.promise);
    const first = h.controller.begin({ scheme: "zeros-dev", installFlow: false });
    await vi.waitFor(() => expect(h.client.start).toHaveBeenCalledOnce());
    await h.controller.begin({ scheme: "zeros-dev", installFlow: false });
    older.resolve({ authorizeUrl: "https://github.com/login/oauth/authorize", expiresAtMs: 2_000_000, flowKind: "oauth" });
    await expect(first).resolves.toBeNull();
    expect(h.pending()?.nonce).toBe("b".repeat(43));
    expect(h.deps.openExternal).toHaveBeenCalledOnce();
  });

  it("rolls back a credential if cancellation lands while secure storage commits", async () => {
    const h = harness();
    const set = h.deps.credentialStore.set;
    h.deps.credentialStore.set = async (...args) => { await set(...args); h.controller.cancel(); };
    await h.controller.begin({ scheme: "zeros-dev", installFlow: false });
    await h.controller.complete({ nonce: "n".repeat(43) });
    expect(h.credential()).toBeNull();
    expect(h.selected()).toBe("gh-cli");
    expect(h.events.some(event => event.name === "connected")).toBe(false);
  });

  it("does not open an old account's browser after account switching during begin", async () => {
    const h = harness();
    const reply = await h.client.start();
    h.client.start.mockImplementation(async () => { h.deps.getSession = async () => ({ sub: "another", accessToken: "another" }); return reply; });
    await expect(h.controller.begin({ scheme: "zeros-dev", installFlow: false })).resolves.toBeNull();
    expect(h.pending()).toBeNull();
    expect(h.deps.openExternal).not.toHaveBeenCalled();
  });
  it("does not exchange an old account's browser attempt after account switching", async () => {
    const h = harness();
    await h.controller.begin({ scheme: "zeros-dev", installFlow: false });
    h.deps.getSession = async () => ({ accessToken: "other-session", sub: "auth0|two" });
    await h.controller.complete({ nonce: "n".repeat(43) });
    expect(h.client.exchange).not.toHaveBeenCalled();
    expect(h.credential()).toBeNull();
  });

  it.each(["cancel", "account switch"])("does not store a handoff completed after %s during exchange", async cause => {
    const h = harness();
    const exchange = deferred<GithubAppTokenResult>();
    const response = await h.client.exchange();
    h.client.exchange.mockImplementation(() => exchange.promise);
    await h.controller.begin({ scheme: "zeros-dev", installFlow: false });
    const completing = h.controller.complete({ nonce: "n".repeat(43) });
    await vi.waitFor(() => expect(h.client.exchange).toHaveBeenCalledTimes(2));
    if (cause === "cancel") h.controller.cancel();
    else h.deps.getSession = async () => ({ accessToken: "other-session", sub: "auth0|two" });
    exchange.resolve(response);
    await completing;
    expect(h.credential()).toBeNull();
    expect(h.events.some(event => event.name === "connected")).toBe(false);
  });

  it("disconnect cancels a browser attempt that has not produced a credential yet", async () => {
    const h = harness();
    await h.controller.begin({ scheme: "zeros-dev", installFlow: false });
    await h.controller.disconnect();
    expect(h.pending()).toBeNull();
  });

  it("keeps Local's selected GitHub method when an organization connects the App", async () => {
    const h = harness();
    await h.controller.begin({ scheme: "zeros", installFlow: false, preserveSelectedMethod: true });
    await h.controller.complete({ nonce: "n".repeat(43) });
    expect(h.credential()?.method).toBe("github-app");
    expect(h.selected()).toBe("gh-cli");
  });

  it("persists the pending nonce before opening the browser", async () => {
    const h = harness();
    h.deps.openExternal = vi.fn(async () => {
      expect(h.pending()).toEqual({
        nonce: "n".repeat(43),
        expiresAtMs: 2_000_000,
        ownerSub: "auth0|one",
      });
    });
    const controller = new GithubAppController(h.deps);

    await expect(
      controller.begin({
        scheme: "zeros-dev",
        installFlow: true,
        forceInstall: true,
      }),
    ).resolves.toBe("oauth");

    expect(h.client.start).toHaveBeenCalledWith(
      "zeros-access",
      expect.objectContaining({
        scheme: "zeros-dev",
        installFlow: true,
        forceInstall: true,
      }),
    );
  });

  it("rejects an unsolicited callback without consuming the real pending flow", async () => {
    const h = harness();
    await h.controller.begin({ scheme: "zeros", installFlow: true });

    await h.controller.complete({ nonce: "x".repeat(43) });

    expect(h.pending()?.nonce).toBe("n".repeat(43));
    expect(h.client.exchange).not.toHaveBeenCalled();
    expect(h.events).toEqual([
      { name: "error", payload: { reason: "nonce_mismatch" } },
    ]);
  });

  it("invalidates the desktop handoff when browser setup is cancelled", async () => {
    const h = harness();
    await h.controller.begin({ scheme: "zeros", installFlow: true });

    h.controller.cancel();
    await h.controller.complete({ nonce: "n".repeat(43) });

    expect(h.pending()).toBeNull();
    expect(h.client.exchange).not.toHaveBeenCalled();
    expect(h.events).toEqual([
      { name: "error", payload: { reason: "handoff_expired" } },
    ]);
  });

  // The Cancel button stays clickable while the connect request is outstanding,
  // and begin() has nothing persisted to clear until the control plane answers.
  it("honors a cancel that lands while begin is still awaiting the control plane", async () => {
    const h = harness();
    const started = deferred<{
      authorizeUrl: string;
      expiresAtMs: number;
      flowKind: "oauth";
    }>();
    h.client.start.mockImplementationOnce(() => started.promise);
    const begun = h.controller.begin({ scheme: "zeros", installFlow: false });

    h.controller.cancel();
    started.resolve({
      authorizeUrl: "https://github.com/login/oauth/authorize?x=1",
      expiresAtMs: 2_000_000,
      flowKind: "oauth",
    });
    await expect(begun).resolves.toBeNull();

    expect(h.pending()).toBeNull();
    expect(h.deps.openExternal).not.toHaveBeenCalled();
    // A callback for that nonce is now unsolicited and cannot connect.
    await h.controller.complete({ nonce: "n".repeat(43) });
    expect(h.client.exchange).not.toHaveBeenCalled();
  });

  // A control plane without the GitHub routes answers its generic 404, whose
  // body says "Not found". Before this, begin() rethrew that verbatim and
  // Settings rendered `GithubAppClientError: Not found` through Electron's IPC
  // wrapper — a dead end that reads like a crash.
  it("reports a control plane with no GitHub routes as not-configured", async () => {
    const h = harness();
    h.client.start.mockRejectedValueOnce(
      new GithubAppClientError("Not found", "not_found", 404, false),
    );

    const failure = await h.controller
      .begin({ scheme: "zeros", installFlow: true })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(GithubAppFlowError);
    const flow = failure as GithubAppFlowError;
    expect(flow.reason).toBe("not_configured");
    // Not terminal: a rolled-back backend must not delete a working credential.
    expect(flow.terminal).toBe(false);
    expect(flow.message).not.toContain("Not found");
    expect(flow.message).toMatch(/gh CLI or a Personal Access Token/);
    expect(h.pending()).toBeNull();
    expect(h.deps.openExternal).not.toHaveBeenCalled();
  });

  it("maps a configured-but-unavailable control plane to a retryable reason", async () => {
    const h = harness();
    h.client.start.mockRejectedValueOnce(
      new GithubAppClientError(
        "upstream connect error or disconnect/reset before headers",
        "http_502",
        502,
        false,
      ),
    );

    const failure = (await h.controller
      .begin({ scheme: "zeros", installFlow: true })
      .catch((error: unknown) => error)) as GithubAppFlowError;

    expect(failure.reason).toBe("github_unavailable");
    // The proxy's own wording never reaches a toast.
    expect(failure.message).not.toContain("upstream");
  });

  it("keeps a still-valid App credential when refresh hits a 404 control plane", async () => {
    const h = harness({
      credential: {
        method: "github-app",
        accessToken: "app-access",
        refreshToken: "app-refresh",
        refreshBinding: binding("a"),
        expiresAtMs: 1_000_500,
        refreshTokenExpiresAtMs: 30_000_000,
        ownerSub: "auth0|one",
        login: "octocat",
        ...gitIdentity,
      },
    });
    h.client.refresh.mockRejectedValueOnce(
      new GithubAppClientError("Not found", "not_found", 404, false),
    );

    await expect(h.controller.refresh()).rejects.toThrow(GithubAppFlowError);
    expect(h.credential()?.accessToken).toBe("app-access");
    expect(h.credential()?.refreshToken).toBe("app-refresh");
  });

  // Holding the credential is right; asking again in 30 s forever is not. A
  // control plane with no GitHub routes recovers on a DEPLOY, so the quick
  // transport retry turns one bad backend into a permanent 404 storm from
  // every machine that ever connected.
  it.each([
    [
      "a control plane with no GitHub routes",
      new GithubAppClientError("Not found", "not_found", 404, false),
      GITHUB_APP_UNAVAILABLE_REFRESH_RETRY_MS,
    ],
    [
      "a genuine transport blip",
      new GithubAppClientError("offline", "network", 0, false),
      GITHUB_APP_TRANSIENT_REFRESH_RETRY_MS,
    ],
  ] as const)("paces the retry after %s", async (_label, failure, expected) => {
    const h = harness({
      credential: {
        method: "github-app",
        accessToken: "app-access",
        refreshToken: "app-refresh",
        refreshBinding: binding("a"),
        expiresAtMs: 1_000_500,
        refreshTokenExpiresAtMs: 30_000_000,
        ownerSub: "auth0|one",
        login: "octocat",
        ...gitIdentity,
      },
    });
    h.client.refresh.mockRejectedValueOnce(failure);

    await expect(h.controller.refresh()).rejects.toThrow(GithubAppFlowError);

    expect(h.afterTransientRefreshFailure).toHaveBeenCalledWith(expected);
    // Either way the rotating pair survives — the state is reversible.
    expect(h.credential()?.accessToken).toBe("app-access");
  });

  // A forced refresh exists because something ALREADY rejected the current
  // access token (githubSelectedTokenStore.refreshAfterRejection). Joining an
  // in-flight NON-forced pass hands back whatever that pass decided to keep —
  // and a non-forced pass is allowed to keep the token untouched. The rejected
  // token then comes straight back, and its caller has no second lever.
  it("does not let a forced refresh settle for an in-flight non-forced pass", async () => {
    const stale: AppCredential = {
      method: "github-app",
      accessToken: "app-access",
      refreshToken: "app-refresh",
      refreshBinding: binding("a"),
      expiresAtMs: 1_030_000, // due: within 60s of the harness clock
      refreshTokenExpiresAtMs: 30_000_000,
      ownerSub: "auth0|one",
      login: "octocat",
      ...gitIdentity,
    };
    // Same rotating pair, later expiry — what a sibling worktree writing
    // through the shared store looks like from in here.
    const extended: AppCredential = { ...stale, expiresAtMs: 9_000_000 };

    const h = harness({ credential: stale });
    let rotatedByPeer = false;
    h.deps.credentialStore.get = async () => (rotatedByPeer ? extended : stale);
    const gate = deferred<void>();
    h.deps.withCredentialLock = async (operation) => {
      await gate.promise;
      return operation();
    };
    const controller = new GithubAppController(h.deps);

    const scheduled = controller.refresh(); // due, so it takes the lock
    const forced = controller.refresh({ force: true });
    rotatedByPeer = true;
    gate.resolve();
    const [kept, rotated] = await Promise.all([scheduled, forced]);

    // The non-forced pass legitimately keeps the token: no longer due.
    expect(kept?.accessToken).toBe("app-access");
    // The forced pass must NOT inherit that answer.
    expect(rotated?.accessToken).toBe("app-access-rotated");
    expect(h.client.refresh).toHaveBeenCalledTimes(1);
  });

  it("lets a forced refresh reuse a rotation the earlier pass already did", async () => {
    const h = harness({
      credential: {
        method: "github-app",
        accessToken: "app-access",
        refreshToken: "app-refresh",
        refreshBinding: binding("a"),
        expiresAtMs: 1_030_000,
        refreshTokenExpiresAtMs: 30_000_000,
        ownerSub: "auth0|one",
        login: "octocat",
        ...gitIdentity,
      },
    });
    const gate = deferred<void>();
    h.deps.withCredentialLock = async (operation) => {
      await gate.promise;
      return operation();
    };
    const controller = new GithubAppController(h.deps);

    const scheduled = controller.refresh();
    const forced = controller.refresh({ force: true });
    gate.resolve();
    const [first, second] = await Promise.all([scheduled, forced]);

    // The pair genuinely changed, which is all the forced caller needed —
    // so it must not spend a second rotation on the same slot.
    expect(first?.accessToken).toBe("app-access-rotated");
    expect(second?.accessToken).toBe("app-access-rotated");
    expect(h.client.refresh).toHaveBeenCalledTimes(1);
  });

  it("binds the exchanged credential to the current Auth0 subject", async () => {
    const h = harness();
    await h.controller.begin({ scheme: "zeros", installFlow: true });

    await h.controller.complete({ nonce: "n".repeat(43) });

    expect(h.credential()).toMatchObject({
      method: "github-app",
      ownerSub: "auth0|one",
      login: "octocat",
      installationCount: 1,
    });
    expect(h.selected()).toBe("github-app");
    expect(h.events).toEqual([
      {
        name: "connected",
        payload: { login: "octocat", installationCount: 1 },
      },
    ]);
    expect(JSON.stringify(h.events)).not.toContain("app-access");
    expect(JSON.stringify(h.events)).not.toContain("app-refresh");
  });

  it("keeps the previous credential when method selection cannot commit", async () => {
    const previous: AppCredential = {
      ...gitIdentity,
      method: "github-app",
      accessToken: "old-access",
      refreshToken: "old-refresh",
      refreshBinding: binding("c"),
      ownerSub: "auth0|one",
      login: "old-user",
    };
    const h = harness({ credential: previous });
    h.deps.credentialStore.setSelectedMethod = vi.fn(async (method) => {
      if (method === "github-app") throw new Error("settings unavailable");
    });
    const controller = new GithubAppController(h.deps);
    await controller.begin({ scheme: "zeros", installFlow: false });

    await controller.complete({ nonce: "n".repeat(43) });

    expect(h.credential()).toEqual(previous);
    expect(h.events).toEqual([
      { name: "error", payload: { reason: "storage_failed" } },
    ]);
  });

  it("shares one refresh and persists the complete rotated pair", async () => {
    const gate = deferred<{
      accessToken: string;
      refreshToken: string;
      refreshBinding: string;
      expiresAtMs: number;
      refreshTokenExpiresAtMs: number;
    }>();
    const h = harness({
      credential: {
        ...gitIdentity,
        method: "github-app",
        accessToken: "old-access",
        refreshToken: "old-refresh",
        refreshBinding: binding("c"),
        expiresAtMs: 1_030_000,
        refreshTokenExpiresAtMs: 9_000_000,
        ownerSub: "auth0|one",
      },
    });
    h.client.refresh.mockImplementation(async () => gate.promise);

    const first = h.controller.refresh();
    const second = h.controller.refresh();
    gate.resolve({
      accessToken: "rotated-access",
      refreshToken: "rotated-refresh",
      refreshBinding: binding("b"),
      expiresAtMs: 8_000_000,
      refreshTokenExpiresAtMs: 18_000_000,
    });
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);

    expect(h.client.refresh).toHaveBeenCalledTimes(1);
    expect(h.credential()).toMatchObject({
      accessToken: "rotated-access",
      refreshToken: "rotated-refresh",
      refreshBinding: binding("b"),
    });
    expect(h.after).toHaveBeenCalledTimes(1);
  });

  it("rotates a legacy App credential with no access-token expiry instead of treating it as unbounded", async () => {
    const h = harness({
      credential: {
        ...gitIdentity,
        method: "github-app",
        accessToken: "legacy-access",
        refreshToken: "legacy-refresh",
        refreshBinding: binding("c"),
        refreshTokenExpiresAtMs: 9_000_000,
        ownerSub: "auth0|one",
      },
    });

    await expect(h.controller.refresh()).resolves.toMatchObject({
      accessToken: "app-access-rotated",
      expiresAtMs: 11_000_000,
    });
    expect(h.client.refresh).toHaveBeenCalledTimes(1);
  });

  it("retains the old pair on transient failure and clears it on terminal refusal", async () => {
    const original: AppCredential = {
      ...gitIdentity,
      method: "github-app",
      accessToken: "old-access",
      refreshToken: "old-refresh",
      refreshBinding: binding("c"),
      expiresAtMs: 1_030_000,
      refreshTokenExpiresAtMs: 9_000_000,
      ownerSub: "auth0|one",
    };
    const h = harness({ credential: original });
    h.client.refresh.mockRejectedValueOnce(
      new GithubAppClientError("offline", "network", 0, false),
    );
    await expect(h.controller.refresh()).rejects.toMatchObject({
      reason: "github_unavailable",
    });
    expect(h.credential()).toEqual(original);
    expect(h.afterTransientRefreshFailure).toHaveBeenCalledTimes(1);
    expect(h.afterTransientRefreshFailure).toHaveBeenCalledWith(30_000);

    h.client.refresh.mockRejectedValueOnce(
      new GithubAppClientError(
        "expired",
        "github_authorization_expired",
        401,
        true,
      ),
    );
    await expect(h.controller.refresh({ force: true })).resolves.toBeNull();
    expect(h.credential()).toBeNull();
    expect(h.afterTransientRefreshFailure).toHaveBeenCalledTimes(1);
  });

  it("updates installation metadata only on an explicit re-check", async () => {
    const h = harness({
      credential: {
        ...gitIdentity,
        method: "github-app",
        accessToken: "old-access",
        refreshToken: "old-refresh",
        refreshBinding: binding("c"),
        expiresAtMs: 8_000_000,
        refreshTokenExpiresAtMs: 9_000_000,
        ownerSub: "auth0|one",
        login: "octocat",
        repositoryCount: 2,
      },
    });

    await expect(h.controller.refreshInstallations()).resolves.toMatchObject({
      repositoryCount: 7,
      installationCount: 1,
    });
    expect(h.client.refreshInstallations).toHaveBeenCalledWith(
      "zeros-access",
      "old-access",
    );
  });

  it("never serves an App token to a different signed-in Zeros account", async () => {
    const h = harness({
      credential: {
        ...gitIdentity,
        method: "github-app",
        accessToken: "old-access",
        refreshToken: "old-refresh",
        refreshBinding: binding("c"),
        ownerSub: "auth0|one",
      },
      session: { accessToken: "zeros-two", sub: "auth0|two" },
    });

    await expect(h.controller.refresh()).rejects.toBeInstanceOf(
      GithubAppFlowError,
    );
    expect(h.client.refresh).not.toHaveBeenCalled();
  });

  it("disconnects locally even when remote revocation is unavailable", async () => {
    const h = harness({
      credential: {
        ...gitIdentity,
        method: "github-app",
        accessToken: "old-access",
        refreshToken: "old-refresh",
        refreshBinding: binding("c"),
        ownerSub: "auth0|one",
      },
    });
    h.client.revoke.mockRejectedValueOnce(new Error("offline"));

    await expect(h.controller.disconnect()).resolves.toBe(true);
    expect(h.client.revoke).toHaveBeenCalledWith(
      "zeros-access",
      "old-access",
      "old-refresh",
      binding("c"),
    );
    expect(h.credential()).toBeNull();
    expect(h.after).toHaveBeenCalledWith(null);
  });
});
