// The chat and Settings share device-owned browser subscription authentication.
// This compatibility facade keeps the existing footer phases and result shape.
import { useCallback, useSyncExternalStore } from "react";
import { isElectron } from "../../platform/runtime";
import {
  connectSubscription,
  isSubscriptionProvider,
  subscriptionCache,
} from "../settings/subscription-connection";
import type { BrowserSubscriptionProvider } from "@zeros/protocol/provider-auth";

export const supportsBackgroundSignIn = isSubscriptionProvider;
export type SignInPhase = "idle" | "starting" | "waiting" | "success" | "error";
export interface SignInState {
  phase: SignInPhase;
  error?: string;
}
export interface SignInResult {
  ok: boolean;
  error?: string;
}
const IDLE: SignInState = { phase: "idle" };
const STARTING: SignInState = { phase: "starting" };
const WAITING: SignInState = { phase: "waiting" };
const states = new Map<BrowserSubscriptionProvider, SignInState>();
const listeners = new Set<() => void>();
const inflight = new Map<BrowserSubscriptionProvider, Promise<SignInResult>>();
function setState(provider: BrowserSubscriptionProvider, state: SignInState) {
  states.set(provider, state);
  for (const listener of listeners) listener();
}
export function getSignInState(
  provider: string | null | undefined,
): SignInState {
  if (!isSubscriptionProvider(provider)) return IDLE;
  const status = subscriptionCache.getSnapshot(provider).data;
  if (status?.state === "connecting")
    return status.attemptId ? WAITING : STARTING;
  return states.get(provider) ?? IDLE;
}
export function useBackgroundSignIn(
  provider: string | null | undefined,
  active = true,
): SignInState {
  const subscribe = useCallback(
    (listener: () => void) => {
      if (!active || !isSubscriptionProvider(provider)) return () => {};
      listeners.add(listener);
      const off = subscriptionCache.subscribe(provider, listener);
      return () => {
        listeners.delete(listener);
        off();
      };
    },
    [active, provider],
  );
  return useSyncExternalStore(subscribe, () => getSignInState(provider));
}
export function startBackgroundSignIn(provider: string): Promise<SignInResult> {
  if (!isElectron())
    return Promise.resolve({
      ok: false,
      error: "Background sign-in is available only in the Zeros Mac app.",
    });
  if (!isSubscriptionProvider(provider))
    return Promise.resolve({
      ok: false,
      error: "Sign-in is not supported for this agent.",
    });
  const pending = inflight.get(provider);
  if (pending) return pending;
  setState(provider, STARTING);
  const run = connectSubscription(provider)
    .then((status) => {
      const result = {
        ok: status.state === "connected" && !status.error,
        error: status.error,
      };
      const state: SignInState = result.ok
        ? { phase: "success" }
        : { phase: "error", error: status.error };
      setState(provider, state);
      if (result.ok)
        setTimeout(() => {
          if (states.get(provider) === state) setState(provider, IDLE);
        }, 4000);
      return result;
    })
    .catch(() => {
      const error =
        "Could not start browser sign-in. Try again from Settings → Providers.";
      setState(provider, { phase: "error", error });
      return { ok: false, error };
    })
    .finally(() => {
      if (inflight.get(provider) === run) inflight.delete(provider);
    });
  inflight.set(provider, run);
  return run;
}
