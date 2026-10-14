import { hasCloudWorkspaceAccountAccess } from "../features/team/cloud-workspace-account-access";
import { ControlPlaneError } from "../features/team/control-plane";
import { cloudWorkspaceKey, type CloudWorkspaceTarget } from "../platform/bridge/cloud-workspace-key";
import type { CloudWorkspaceDocument } from "../platform/cloud-workspaces";
import {
  canReadCloudWorkspace,
  cloudCatalogGeneration,
  cloudWorkspaceDocument,
  cloudWorkspaceOwnerGeneration,
  cloudWorkspaceStopVersion,
  isCloudWorkspaceLifecyclePending,
  manageCloudWorkspace,
  refreshCloudWorkspace,
  subscribeCloudWorkspaces,
} from "./cloud-workspace-catalog";

/** A later Stop or terminal lifecycle state ends this intent; readiness retries
 * must keep the user's queued message instead of starting another wake. */
export class CloudWorkspaceWakeEndedError extends Error {
  readonly name = "CloudWorkspaceWakeEndedError";
  constructor(message: string, readonly reason: "workspace_stopped" | "queued_timeout" = "workspace_stopped") { super(message); }
}

/** Ephemeral identity owned by one navigation, interaction or queued-send
 * attempt. Retain it through readiness retries; it is never run authority. */
export interface CloudWorkspaceWakeIntent { readonly id: string }
interface WakeIntentState {
  id: string;
  reason?: "interaction";
  account: number;
  workspace: string;
  owner: number | undefined;
  stopVersion: number;
  startedAt: number;
  generation: number;
  replacement: boolean;
  confirmed: boolean;
  request?: Promise<CloudWorkspaceDocument>;
  refusal?: unknown;
}
// State expires with the caller's intent, not an unbounded global ID cache.
const wakeIntents = new WeakMap<CloudWorkspaceWakeIntent, WakeIntentState>();
const WAKE_LIMIT_MS = 15 * 60_000;

/** Only explicit open/send/interaction callers may enter here. Catalog/history/hover reads
 * must not acquire compute. Cancellation ends the local intent, not an already
 * accepted server lifecycle operation. Admission is acquired or revalidated afterwards. */
export async function wakeCloudWorkspace(
  target: CloudWorkspaceTarget,
  initial: CloudWorkspaceDocument,
  signal?: AbortSignal,
  reason?: "interaction",
  intent?: CloudWorkspaceWakeIntent,
): Promise<CloudWorkspaceDocument> {
  const account = cloudCatalogGeneration();
  const stopVersion = cloudWorkspaceStopVersion(target);
  let state = intent ? wakeIntents.get(intent) : undefined;
  if (intent && !state) {
    state = { id: intent.id, reason, account, workspace: cloudWorkspaceKey(target), owner: cloudWorkspaceOwnerGeneration(target),
      stopVersion, startedAt: performance.now(), generation: initial.generation.number, replacement: false, confirmed: false };
    wakeIntents.set(intent, state);
  }
  let generation = state?.generation ?? initial.generation.number;
  let replacement = state?.replacement ?? false;
  const controller = new AbortController();
  let expired = false;
  const cancel = () => controller.abort();
  signal?.addEventListener("abort", cancel, { once: true });
  const assertCurrent = () => {
    if (signal?.aborted) throw new Error("Cloud workspace wake cancelled");
    if (state?.refusal) throw state.refusal;
    if (account !== cloudCatalogGeneration()) throw new Error("Cloud account changed while waking");
    if (state && (state.account !== account || state.workspace !== cloudWorkspaceKey(target) ||
        state.owner !== cloudWorkspaceOwnerGeneration(target)))
      throw new CloudWorkspaceWakeEndedError("Cloud account or workspace owner changed. Open it again to retry.");
    if (state && state.stopVersion !== stopVersion)
      throw new CloudWorkspaceWakeEndedError("Cloud workspace was stopped. Open it again to retry.");
    const current = cloudWorkspaceDocument(target);
    if (!current || !canReadCloudWorkspace(current) || current.generation.number < generation && !isCloudWorkspaceLifecyclePending(current))
      throw new Error("Cloud workspace generation or access changed while waking");
    if (!hasCloudWorkspaceAccountAccess(target.organizationId) || !current.capabilities.canWrite)
      throw new Error("Cloud workspace run access is required to wake it");
    if (cloudWorkspaceStopVersion(target) !== stopVersion)
      throw new CloudWorkspaceWakeEndedError("Cloud workspace was stopped. Open it again to retry.");
    if (["archived", "archiving", "failed", "error"].includes(current.status) || current.error && current.status !== "stopped")
      throw new CloudWorkspaceWakeEndedError(current.error?.message ?? `Cloud workspace is ${current.status}. Open it again to retry.`);
    if (expired || state && performance.now() - state.startedAt >= WAKE_LIMIT_MS)
      throw new CloudWorkspaceWakeEndedError("The cloud workspace is still starting after fifteen minutes. Try again when it is ready.", "queued_timeout");
    // Upgrade-on-wake or its rollback replaces the engine, not the user intent.
    // Keep waiting through its drain/setup; never reuse the old admission.
    if (current.generation.number !== generation) replacement = true;
    generation = current.generation.number;
    if (state) { state.generation = generation; state.replacement = replacement; }
    return current;
  };
  const requestWake = () => {
    if (!state || !intent) return manageCloudWorkspace(target, "wake", false, reason);
    if (state.confirmed) return Promise.resolve(assertCurrent());
    if (state.request) return state.request;
    const captured = state;
    const request = manageCloudWorkspace(target, "wake", false, captured.reason, captured.id).then(doc => {
      captured.confirmed = true;
      return doc;
    }, error => {
      // Unknown outcomes may retry only this same ID. A definitive refusal
      // needs a fresh explicit user attempt, not another readiness retry.
      if (error instanceof ControlPlaneError && error.status >= 400 && error.status < 500 &&
          ![408, 425, 429].includes(error.status)) captured.refusal = error;
      throw error;
    }).finally(() => { if (captured.request === request) captured.request = undefined; });
    captured.request = request;
    return request;
  };
  let onProgress: ((current: CloudWorkspaceDocument) => void) | undefined;
  const off = subscribeCloudWorkspaces(() => {
    try {
      const current = assertCurrent();
      onProgress?.(current);
    } catch { cancel(); }
  });
  const wait = <T>(promise: Promise<T>): Promise<T> => new Promise((resolve, reject) => {
    const abort = () => {
      try { assertCurrent(); } catch (error) { reject(error); return; }
      reject(new Error("Cloud workspace wake cancelled"));
    };
    controller.signal.addEventListener("abort", abort, { once: true });
    if (controller.signal.aborted) abort();
    promise.then(resolve, reject).finally(() => controller.signal.removeEventListener("abort", abort));
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const waitForProgress = async (previous: CloudWorkspaceDocument) => {
    const progress = new Promise<void>((resolve, reject) => {
      onProgress = current => { if (current !== previous) resolve(); };
      // Catalog/runtime publications settle immediately, including while a
      // detail refresh is hung. Poll only when no exact-workspace event arrives.
      timer = setTimeout(() => {
        timer = undefined;
        void refreshCloudWorkspace(target).then(() => resolve(), reject);
      }, 2_000);
    });
    try { await wait(progress); }
    finally { onProgress = undefined; clearTimeout(timer); }
  };
  // Compute drain/create/setup are server-owned progress, not agent admission
  // time. Keep waiting without a short client deadline; bound even hung IPC
  // with one elapsed (clock-skew-independent) fifteen-minute safety cap.
  const safety = setTimeout(() => { expired = true; cancel(); },
    Math.max(0, WAKE_LIMIT_MS - (state ? performance.now() - state.startedAt : 0)));
  try {
    let current = assertCurrent();
    // An open arriving during final capture waits for stop to finish. After a
    // wake has begun, a later Stop wins; never loop by waking it a second time.
    let mayWake = !state?.confirmed && ["stopped", "stopping"].includes(current.status);
    // Ready is not proof that final capture is absent. The existing wake
    // transaction cancels an uncommitted idle checkpoint, or serializes a
    // committed drain before fresh runtime admission is allowed.
    if (["ready", "busy"].includes(current.status)) {
      await wait(requestWake());
      current = assertCurrent();
    }
    while (!["ready", "busy"].includes(current.status)) {
      if (current.status === "stopped" && mayWake) {
        mayWake = false;
        await wait(requestWake());
        current = assertCurrent();
        continue;
      }
      if (!["stopping", "waking", "provisioning", "setting_up"].includes(current.status) ||
          (current.status === "stopping" && !mayWake && !replacement))
        throw new CloudWorkspaceWakeEndedError(current.error?.message ?? `Cloud workspace is ${current.status}. Open it again to retry.`);
      await waitForProgress(current);
      current = assertCurrent();
    }
    // Joining an existing start also satisfies this intent's lifecycle work.
    // This receipt suppresses only a duplicate wake; admission and the live
    // root are still checked by every preparation. A later drain is new work.
    if (state) { state.confirmed = true; state.replacement = false; }
    return current;
  } finally {
    clearTimeout(timer);
    clearTimeout(safety);
    off();
    signal?.removeEventListener("abort", cancel);
  }
}
