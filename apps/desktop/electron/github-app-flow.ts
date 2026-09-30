import { hostedDevGithubReferencesEnabled,saveDevGithubReference,readDevGithubReference,clearDevGithubReference } from "./github-auth-runtime";
// Production host wiring for the GitHub App controller.
//
// All secrets remain in Electron main. Deep links carry only a single-use
// nonce; renderer events carry username/count/error-reason metadata only.

import { randomBytes, timingSafeEqual } from "node:crypto";
import type { GithubCredential } from "@zeros/protocol/github-auth";

import { channel, schemeForChannel } from "../src/engine/runtime";
import {
  getProductAccountIdForMain,
  getSessionUserForMain,
  getValidSessionForMain,
} from "./ipc/commands/auth-session";
import { emitEvent } from "./ipc/events";
import {
  githubCredentialStore,
  replaceGithubAppCredentialIfCurrent,
} from "./github-auth-runtime";
import { GithubAppClient, type GithubAppFlowKind } from "./github-app-client";
import {
  GithubAppController,
  GithubAppFlowError,
  refreshRetryDelayMs,
  type GithubAppConnectionErrorReason,
  type PendingConsumeResult,
} from "./github-app-controller";
import {
  getSecret,
  replaceSecretIfUnchanged,
  secretsFilePath,
  setSecret,
} from "./secret-store";
import { pushGithubCredentialToEngine } from "./sidecar";
import { IS_DEV } from "./runtime-mode";
import { GithubDevCallbackRelay, GithubDevPendingHandoff } from "./github-dev-callback-relay";
import { localDevCallbackStore } from "./local-dev-callback-store";
import {
  CrossProcessLockTimeoutError,
  withCrossProcessFileLock,
} from "./cross-process-lock";

declare const __ZEROS_CONTROL_PLANE_URL_BAKED__: string | undefined;

type GithubAppCredential = Extract<GithubCredential, { method: "github-app" }>;

const PENDING_ACCOUNT = "github-app-handoff:pending";
const MAX_TIMER_MS = 2_147_000_000;
const CREDENTIAL_LOCK_STALE_MS = 60_000;
const CREDENTIAL_LOCK_WAIT_MS = 65_000;
let devRelay: GithubDevCallbackRelay | undefined;
let devHandoff: GithubDevPendingHandoff | undefined;

function githubDevRelay(): GithubDevCallbackRelay {
  return (devRelay ??= new GithubDevCallbackRelay(localDevCallbackStore()));
}

function githubDevHandoff(): GithubDevPendingHandoff {
  return (devHandoff ??= new GithubDevPendingHandoff(githubDevRelay(), callback => {
    void githubAppController().complete(callback).catch(() => {
      emitEvent("github-app-error", { reason: "github_unavailable" });
    });
  }));
}

function controlPlaneBaseUrl(): string {
  const baked =
    typeof __ZEROS_CONTROL_PLANE_URL_BAKED__ === "string"
      ? __ZEROS_CONTROL_PLANE_URL_BAKED__
      : "";
  return (
    process.env.ZEROS_CONTROL_PLANE_URL?.trim() ||
    process.env.VITE_CONTROL_PLANE_URL?.trim() ||
    baked.trim() ||
    "https://api.zeros.build"
  );
}

function sameNonce(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function readPending(): {
  raw: string;
  nonce: string;
  expiresAtMs: number;
  preserveSelectedMethod: boolean;
  ownerSub?: string;
} | null {
  const raw = getSecret(PENDING_ACCOUNT);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (
      typeof parsed.nonce !== "string" ||
      typeof parsed.expiresAtMs !== "number" ||
      !Number.isFinite(parsed.expiresAtMs)
    ) {
      return null;
    }
    return {
      raw,
      nonce: parsed.nonce,
      expiresAtMs: parsed.expiresAtMs,
      preserveSelectedMethod: parsed.preserveSelectedMethod === true,
      ...(typeof parsed.ownerSub === "string" ? { ownerSub: parsed.ownerSub } : {}),
    };
  } catch {
    return null;
  }
}

function consumePending(nonce: string): PendingConsumeResult {
  if (channel() === "dev") return githubDevHandoff().consume(nonce);
  const pending = readPending();
  if (!pending) return { status: "missing" };
  if (pending.expiresAtMs <= Date.now()) {
    replaceSecretIfUnchanged(PENDING_ACCOUNT, pending.raw, null);
    return { status: "expired" };
  }
  if (!sameNonce(pending.nonce, nonce)) return { status: "mismatch" };
  return replaceSecretIfUnchanged(PENDING_ACCOUNT, pending.raw, null)
    ? { status: "consumed", preserveSelectedMethod: pending.preserveSelectedMethod, ownerSub: pending.ownerSub }
    : { status: "missing" };
}

function discardPending(nonce: string): void {
  if (channel() === "dev") { devHandoff?.discard(nonce); return; }
  const pending = readPending();
  if (pending && sameNonce(pending.nonce, nonce)) {
    replaceSecretIfUnchanged(PENDING_ACCOUNT, pending.raw, null);
  }
}

function clearPending(): void {
  if (channel() === "dev") { devHandoff?.clear(); return; }
  const pending = readPending();
  if (pending) {
    replaceSecretIfUnchanged(PENDING_ACCOUNT, pending.raw, null);
  }
}

async function withCredentialLock<T>(operation: () => Promise<T>): Promise<T> {
  const lockPath = `${secretsFilePath()}.github-app-refresh.lock`;
  try {
    return await withCrossProcessFileLock(lockPath, operation, {
      staleAfterMs: CREDENTIAL_LOCK_STALE_MS,
      waitTimeoutMs: CREDENTIAL_LOCK_WAIT_MS,
    });
  } catch (error) {
    // Only the acquisition timeout is ours to reword — the operation's own
    // failures must reach the caller unchanged. Without this the UI showed the
    // lock's filename ("Timed out waiting for lock …github-app-refresh.lock").
    if (error instanceof CrossProcessLockTimeoutError) {
      throw new GithubAppFlowError(
        "Another Zeros window is still finishing a GitHub refresh. Try again in a moment.",
        "github_unavailable",
        false,
        { cause: error },
      );
    }
    throw error;
  }
}

let refreshTimer: ReturnType<typeof setTimeout> | null = null;
let scheduleGeneration = 0;

async function afterCredentialChange(
  _credential: GithubAppCredential | null,
): Promise<void> {
  await pushGithubCredentialToEngine();
  emitEvent("github-credential-store-changed", {});
  void scheduleGithubAppRefresh();
}

let controller: GithubAppController | null = null;

/** Construct only when the integration is used. A malformed development env
 * override should fail the connect action clearly, not crash Electron while
 * its command modules are being imported during app startup. */
function githubAppController(): GithubAppController {
  if (controller) return controller;
  let client: GithubAppClient;
  try {
    client = new GithubAppClient({
      baseUrl: controlPlaneBaseUrl(),
      allowInsecureLoopback: IS_DEV,
    });
  } catch (error) {
    // A bad ZEROS_CONTROL_PLANE_URL / baked origin is a configuration fault, not
    // a GitHub fault. Report it as "not configured" so Settings shows the same
    // actionable copy as a control plane without the GitHub routes, and keep the
    // validator's own sentence — it names the problem and holds no secret.
    throw new GithubAppFlowError(
      `${error instanceof Error ? error.message : "The Zeros control-plane URL is unusable"}.`,
      "not_configured",
      false,
      { cause: error },
    );
  }
  controller = new GithubAppController({
    ...(hostedDevGithubReferencesEnabled()?{devReference:{
      exchange:(token:string,nonce:string)=>client.exchangeDevReference(token,nonce),save:saveDevGithubReference,
      async disconnect(){
        const session=await getValidSessionForMain(),reference=await readDevGithubReference();
        if(session&&reference)await client.removeDevReference(session.accessToken,reference.reference.bindingId,'local');
        await clearDevGithubReference();await afterCredentialChange(null);return true;
      },
    }}:{}),
    client,
    credentialStore: {
      async get() {
        const credential = await githubCredentialStore.get("github-app");
        return credential?.method === "github-app" ? credential : null;
      },
      set: (method, credential) =>
        githubCredentialStore.set(method, credential),
      clear: (method) => githubCredentialStore.clear(method),
      getSelectedMethod: () => githubCredentialStore.getSelectedMethod(),
      setSelectedMethod: (method) =>
        githubCredentialStore.setSelectedMethod(method),
    },
    compareAndSetCredential: replaceGithubAppCredentialIfCurrent,
    getSession: async () => {
      const session = await getValidSessionForMain();
      return session
        ? {
            accessToken: session.accessToken,
            // Controller field name is serialized compatibility; its value is
            // the stable Zeros account UUID in WorkOS mode.
            sub: session.accountId ?? session.sub,
          }
        : null;
    },
    savePending(input) {
      if (channel() === "dev") { githubDevHandoff().save(input); return; }
      setSecret(PENDING_ACCOUNT, JSON.stringify(input));
    },
    consumePending,
    discardPending,
    clearPending,
    openExternal: async (url) => {
      const { openDesktopAuthBrowser } = await import("./deep-link");
      await openDesktopAuthBrowser(url);
    },
    randomNonce: () => randomBytes(32).toString("base64url"),
    withCredentialLock,
    afterCredentialChange,
    afterTransientRefreshFailure: (retryAfterMs) =>
      scheduleGithubAppRefresh(retryAfterMs),
    emitConnected(payload) {
      emitEvent("github-app-connected", payload);
    },
    emitError(reason: GithubAppConnectionErrorReason) {
      emitEvent("github-app-error", { reason });
    },
  });
  return controller;
}

export async function beginGithubAppConnection(
  installFlow: boolean,
  forceInstall = false,
  preserveSelectedMethod = false,
): Promise<GithubAppFlowKind | null> {
  return githubAppController().begin({
    scheme: schemeForChannel(channel()),
    installFlow,
    forceInstall,
    preserveSelectedMethod,
  });
}

export function cancelGithubAppConnection(): void {
  // Route through the controller so an in-flight begin() observes the cancel:
  // it reaches the control plane before persisting anything, so clearing state
  // alone would let it open the browser and stay redeemable after the user
  // cancelled. Cancellation must still work when a development control-plane URL
  // is misconfigured, so fall back to the local cleanup the controller would
  // have done — there can be no in-flight begin() if constructing it throws.
  try {
    githubAppController().cancel();
  } catch {
    clearPending();
  }
}

/** Called directly by the trusted deep-link router. Raw URLs and tokens never
 *  cross the renderer event bus. */
export function relayGithubAppCallback(input: {
  nonce: string | null;
  error?: string | null;
}): boolean {
  return channel() === "dev" && githubDevRelay().deliver(input);
}

export async function completeGithubAppConnection(input: {
  nonce: string | null;
  error?: string | null;
}): Promise<void> {
  if (relayGithubAppCallback(input)) return;
  await githubAppController().complete(input);
}

export async function refreshGithubAppCredential(
  input: {
    force?: boolean;
  } = {},
): Promise<GithubAppCredential | null> {
  return githubAppController().refresh(input);
}

export async function recheckGithubAppInstallations(): Promise<GithubAppCredential | null> {
  return githubAppController().refreshInstallations();
}

export async function disconnectGithubApp(): Promise<boolean> {
  const removed = await githubAppController().disconnect();
  if (removed) {
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = null;
  }
  return removed;
}

/** Schedule proactive T−60 s rotation. Long (6-month) delays are stepped
 *  through Node's maximum timer interval; transient failures retry quietly. */
export async function scheduleGithubAppRefresh(
  retryAfterMs?: number,
): Promise<void> {
  const generation = ++scheduleGeneration;
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = null;
  const stored = await githubCredentialStore.get("github-app");
  const credential = stored?.method === "github-app" ? stored : null;
  if (
    generation !== scheduleGeneration ||
    !credential ||
    (retryAfterMs === undefined && !credential.expiresAtMs)
  ) {
    return;
  }
  const session = getSessionUserForMain();
  const accountId = getProductAccountIdForMain();
  if (
    generation !== scheduleGeneration ||
    !session ||
    !accountId ||
    !credential.ownerSub ||
    credential.ownerSub !== accountId
  ) {
    return;
  }
  const untilRefresh =
    retryAfterMs ??
    Math.max(1_000, credential.expiresAtMs! - Date.now() - 60_000);
  const delay = Math.min(untilRefresh, MAX_TIMER_MS);
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    // Constructing the controller validates the control-plane URL and can
    // throw. Inside a timer callback that would be an uncaught exception in the
    // main process, so the whole call — not just the promise — is guarded.
    try {
      void githubAppController()
        .refresh()
        .then(
          () => scheduleGithubAppRefresh(),
          (error: unknown) =>
            // Re-arm on the SAME schedule the controller just asked for. This
            // handler used to hardcode 30 s, which quietly overrode the longer
            // backoff a durable failure earns and put the retry storm back.
            scheduleGithubAppRefresh(
              refreshRetryDelayMs(
                error instanceof GithubAppFlowError
                  ? error.reason
                  : "github_unavailable",
              ),
            ),
        );
    } catch (error) {
      console.error("[Zeros] GitHub App refresh could not start:", error);
    }
  }, delay);
  refreshTimer.unref?.();
}

/** Boot hook. It never blocks engine startup on network; expired credentials
 *  are filtered from the initial courier and the scheduler refreshes shortly. */
export async function initializeGithubAppFlow(): Promise<void> {
  await scheduleGithubAppRefresh();
}

/** Shared dev worktrees receive safeStorage changes through fs.watch. */
export async function handleSharedGithubCredentialChange(): Promise<void> {
  emitEvent("github-credential-store-changed", {});
  await pushGithubCredentialToEngine();
  await scheduleGithubAppRefresh();
}

/** Normal sign-in plus the exact backend/generation restores the separate slot.
 * No shared legacy safeStorage pair is read or advanced in reference mode. */
export async function restoreDevGithubBinding(organizationId:string){
  const session=await getValidSessionForMain();if(!session||!hostedDevGithubReferencesEnabled())throw new Error('Sign in to Zeros to restore Dev GitHub');
  const existing=await readDevGithubReference();if(existing)return existing.reference.bindingId;
  const client=new GithubAppClient({baseUrl:controlPlaneBaseUrl()});
  const result=await client.restoreDevReference(session.accessToken,organizationId);
  const current=await getValidSessionForMain();if(current?.sub!==session.sub||current?.accountId!==session.accountId)throw new Error('Your account changed');
  await saveDevGithubReference(result);return result.reference.bindingId;
}
