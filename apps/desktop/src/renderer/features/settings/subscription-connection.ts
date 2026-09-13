import {
  browserSubscriptionProviderSchema,
  providerSubscriptionStatusSchema,
  type BrowserSubscriptionProvider,
  type ProviderSubscriptionStatus,
  type ProviderSubscriptionAction,
} from "@zeros/protocol/provider-auth";
import { KeyedAsyncCache } from "../../shared/lib/keyed-async-cache";
import { isElectron, nativeInvoke, nativeListen } from "../../platform/runtime";
import { flushAgentPreferences } from "../../platform/agent-preferences";
import { providerAuthChanged } from "../../platform/provider-auth-state";
import { invalidateAgentsCache } from "../agent/agents-cache";
import { getProviderPrefs, setProviderPrefs } from "./provider-prefs";
import { pruneProviderUsageAccounts } from "./provider-usage-storage";

/** Device-owned state, shared by Settings and every chat, independent of the
 * selected workspace/engine. Native revisions order reads, ACKs and events. */
export const subscriptionCache =
  new KeyedAsyncCache<ProviderSubscriptionStatus>({ maxEntries: 3 });
let listening: Promise<() => void> | undefined;
const retiredAttempts = new Map<BrowserSubscriptionProvider, string>();
class SignInTimeout extends Error {
  constructor() {
    super("Sign-in timed out. Try connecting again.");
  }
}
function bounded<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new SignInTimeout()), ms);
    work.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}
const runs = new Map<
  BrowserSubscriptionProvider,
  {
    cancelRequested: boolean;
    starting: boolean;
    start: Promise<ProviderSubscriptionStatus>;
    done: Promise<ProviderSubscriptionStatus>;
  }
>();

export function isSubscriptionProvider(
  value: unknown,
): value is BrowserSubscriptionProvider {
  return browserSubscriptionProviderSchema.safeParse(value).success;
}

const completedAttempts = new Map<BrowserSubscriptionProvider, string>();
function acceptStatus(
  raw: unknown,
  expected?: BrowserSubscriptionProvider,
): ProviderSubscriptionStatus {
  const status = providerSubscriptionStatusSchema.parse(raw);
  if (expected && status.provider !== expected)
    throw new Error("Subscription status belongs to a different provider.");
  const current = subscriptionCache.getSnapshot(status.provider).data;
  if (
    current &&
    status.state === "connecting" &&
    status.attemptId === retiredAttempts.get(status.provider)
  )
    return current;
  if (current && current.revision >= status.revision) return current;
  if (status.accounts) pruneProviderUsageAccounts(status.provider, status.accounts.map((account) => account.id));
  subscriptionCache.setData(status.provider, status);
  if (
    status.attemptId &&
    status.state !== "connecting" &&
    completedAttempts.get(status.provider) !== status.attemptId
  ) {
    completedAttempts.set(status.provider, status.attemptId);
    providerAuthChanged();
    invalidateAgentsCache();
  }
  return status;
}

async function listen(): Promise<void> {
  if (!isElectron())
    throw new Error("Subscription sign-in requires the Zeros desktop app.");
  // One bounded native subscription for the app lifetime; no hidden polling.
  listening ??= nativeListen("provider-subscription-status", (raw) => {
    if (providerSubscriptionStatusSchema.safeParse(raw).success)
      acceptStatus(raw);
  });
  try {
    await listening;
  } catch {
    listening = undefined;
    throw new Error("Could not watch subscription sign-in. Try again.");
  }
}

export async function readSubscription(
  key: string,
): Promise<ProviderSubscriptionStatus> {
  const provider = browserSubscriptionProviderSchema.parse(key);
  await bounded(listen(), 20_000);
  if (runs.get(provider)?.starting)
    return subscriptionCache.getSnapshot(provider).data!;
  const result = await bounded(
    nativeInvoke("provider_subscription", {
      provider,
      action: "status",
    }),
    20_000,
  );
  return acceptStatus(result, provider);
}

function waitForCompletion(
  provider: BrowserSubscriptionProvider,
  attemptId: string,
): Promise<ProviderSubscriptionStatus> {
  return new Promise((resolve, reject) => {
    const check = () => {
      const status = subscriptionCache.getSnapshot(provider).data;
      if (status?.attemptId === attemptId && status.state !== "connecting") {
        clearTimeout(timer);
        off();
        resolve(status);
      }
    };
    const off = subscriptionCache.subscribe(provider, check);
    const timer = setTimeout(() => {
      off();
      reject(new SignInTimeout());
    }, 6 * 60_000);
    check();
  });
}

export function connectSubscription(
  provider: BrowserSubscriptionProvider,
): Promise<ProviderSubscriptionStatus> {
  const previous = runs.get(provider);
  if (previous) {
    // Native completion is published before the old promise's finally clears
    // this map. A new Add account click in that interval must start a new
    // ceremony after cleanup, rather than silently rejoining the cancelled one.
    if (
      previous.cancelRequested ||
      subscriptionCache.getSnapshot(provider).data?.state !== "connecting"
    )
      return previous.done.then(() => connectSubscription(provider));
    return previous.done;
  }
  const current = subscriptionCache.getSnapshot(provider).data;
  const revision = current?.revision ?? 0;
  // A reloaded renderer can already know the native ceremony. Keep its ID so
  // an equal-revision connect ACK can rejoin it instead of losing the waiter.
  if (current?.state !== "connecting" || !current.attemptId)
    subscriptionCache.setData(provider, {
      ...current,
      provider,
      state: "connecting",
      revision,
    });
  const run = {
    cancelRequested: false,
    starting: true,
    start: Promise.resolve({} as ProviderSubscriptionStatus),
    done: Promise.resolve({} as ProviderSubscriptionStatus),
  };
  runs.set(provider, run);
  run.start = bounded(
    Promise.resolve().then(async () => {
      await listen();
      if (!run.cancelRequested) {
        setProviderPrefs(provider, {
          ...getProviderPrefs(provider),
          authMethod: "cli",
        });
        await flushAgentPreferences();
      }
      if (run.cancelRequested) {
        run.starting = false;
        const status = await readSubscription(provider);
        return { ...status, error: "Sign-in canceled." };
      }
      const status = providerSubscriptionStatusSchema.parse(
        await nativeInvoke("provider_subscription", {
          provider,
          action: "connect",
        }),
      );
      if (status.provider !== provider)
        throw new Error("Subscription status belongs to a different provider.");
      run.starting = false;
      if (
        run.cancelRequested &&
        status.attemptId &&
        status.state === "connecting"
      ) {
        retiredAttempts.set(provider, status.attemptId);
        await bounded(
          nativeInvoke("provider_subscription", {
            provider,
            action: "cancel",
            attemptId: status.attemptId,
          }),
          20_000,
        )
          .then((result) => acceptStatus(result, provider))
          .catch(() => {});
        return (
          subscriptionCache.getSnapshot(provider).data ?? {
            ...status,
            state: "disconnected",
            canSubmitCode: false,
          }
        );
      }
      return acceptStatus(status, provider);
    }),
    30_000,
  );
  run.done = run.start
    .then(async (status) => {
      if (status.state !== "connecting" || !status.attemptId) return status;
      return waitForCompletion(provider, status.attemptId);
    })
    .catch(async (error: unknown) => {
      run.starting = false;
      run.cancelRequested = true;
      const pending = subscriptionCache.getSnapshot(provider).data;
      if (pending?.state === "connecting" && pending.attemptId) {
        retiredAttempts.set(provider, pending.attemptId);
        // Cancellation is bounded too: a lost IPC response must not keep the
        // Settings button waiting after the ceremony deadline.
        await bounded(
          nativeInvoke("provider_subscription", {
            provider,
            action: "cancel",
            attemptId: pending.attemptId,
          }),
          20_000,
        ).catch(() => {});
      }
      const status = await bounded(readSubscription(provider), 20_000).catch(
        () => ({
          provider,
          state: "disconnected" as const,
          revision,
        }),
      );
      const result = {
        ...status,
        state:
          status.state === "connecting"
            ? ("disconnected" as const)
            : status.state,
        canSubmitCode: false,
        error:
          error instanceof SignInTimeout
            ? error.message
            : "Could not complete browser sign-in. Check the connection and try again.",
      };
      subscriptionCache.setData(provider, result);
      return result;
    })
    .finally(() => {
      if (runs.get(provider) === run) runs.delete(provider);
    });
  return run.done;
}

export async function cancelSubscription(
  provider: BrowserSubscriptionProvider,
): Promise<void> {
  const run = runs.get(provider);
  if (run) run.cancelRequested = true;
  const status = run
    ? await run.start.catch(() => subscriptionCache.getSnapshot(provider).data)
    : subscriptionCache.getSnapshot(provider).data;
  if (status?.state === "connecting" && status.attemptId) {
    retiredAttempts.set(provider, status.attemptId);
    try {
      const result = await bounded(
        nativeInvoke("provider_subscription", {
          provider,
          action: "cancel",
          attemptId: status.attemptId,
        }),
        20_000,
      );
      acceptStatus(result, provider);
    } catch {
      // Retire the local waiter even if the native cancellation ACK is lost.
      // Late connecting events for this attempt cannot reopen the wait state.
    } finally {
      const current = subscriptionCache.getSnapshot(provider).data;
      if (
        current?.attemptId === status.attemptId &&
        current.state === "connecting"
      ) {
        subscriptionCache.setData(provider, {
          ...current,
          state: "disconnected",
          canSubmitCode: false,
          error: "Sign-in canceled. Try connecting again.",
        });
      }
    }
  }
}

export async function submitSubscriptionCode(
  attemptId: string,
  code: string,
): Promise<void> {
  acceptStatus(
    await bounded(
      nativeInvoke("provider_subscription", {
        provider: "claude",
        action: "submit-code",
        attemptId,
        code,
      }),
      20_000,
    ),
  );
}

export async function disconnectCursorSubscription(): Promise<void> {
  await cancelSubscription("cursor");
  await bounded(
    nativeInvoke("cursor_subscription", { action: "disconnect" }),
    20_000,
  );
  await readSubscription("cursor");
  providerAuthChanged();
  invalidateAgentsCache();
}

export async function changeSubscriptionAccount(
  request: Extract<
    ProviderSubscriptionAction,
    { action: "select-account" | "remove-account" | "select-method" }
  >,
): Promise<ProviderSubscriptionStatus> {
  await cancelSubscription(request.provider);
  await listen();
  const status = acceptStatus(
    await bounded(nativeInvoke("provider_subscription", request), 30_000),
    request.provider,
  );
  providerAuthChanged();
  invalidateAgentsCache();
  return status;
}
