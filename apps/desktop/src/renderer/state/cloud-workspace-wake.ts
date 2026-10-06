import { isInternalFeatureActive } from "../features/settings/internal-features";
import type { CloudWorkspaceTarget } from "../platform/bridge/cloud-workspace-key";
import type { CloudWorkspaceDocument } from "../platform/cloud-workspaces";
import {
  canReadCloudWorkspace,
  cloudCatalogGeneration,
  cloudWorkspaceDocument,
  manageCloudWorkspace,
  refreshCloudWorkspace,
  subscribeCloudWorkspaces,
} from "./cloud-workspace-catalog";

/** A later Stop or terminal lifecycle state ends this intent; readiness retries
 * must keep the user's queued message instead of starting another wake. */
export class CloudWorkspaceWakeEndedError extends Error {
  readonly name = "CloudWorkspaceWakeEndedError";
}

/** Only explicit open/send/interaction callers may enter here. Catalog/history/hover reads
 * must not acquire compute. Cancellation ends the local intent, not an already
 * accepted server lifecycle operation. Admission is acquired or revalidated afterwards. */
export async function wakeCloudWorkspace(
  target: CloudWorkspaceTarget,
  initial: CloudWorkspaceDocument,
  signal?: AbortSignal,
  reason?: "interaction",
): Promise<CloudWorkspaceDocument> {
  const account = cloudCatalogGeneration();
  const generation = initial.generation.number;
  const controller = new AbortController();
  const cancel = () => controller.abort();
  signal?.addEventListener("abort", cancel, { once: true });
  const assertCurrent = () => {
    if (signal?.aborted) throw new Error("Cloud workspace wake cancelled");
    if (account !== cloudCatalogGeneration()) throw new Error("Cloud account changed while waking");
    const current = cloudWorkspaceDocument(target);
    if (!current || !canReadCloudWorkspace(current) || current.generation.number !== generation)
      throw new Error("Cloud workspace generation or access changed while waking");
    if (!isInternalFeatureActive("cloudComputerV2") || !current.capabilities.canWrite)
      throw new Error("Cloud workspace run access is required to wake it");
    return current;
  };
  const off = subscribeCloudWorkspaces(() => {
    try { assertCurrent(); } catch { cancel(); }
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
  try {
    let current = assertCurrent();
    // An open arriving during final capture waits for stop to finish. After a
    // wake has begun, a later Stop wins; never loop by waking it a second time.
    let mayWake = ["stopped", "stopping"].includes(current.status);
    // Ready is not proof that final capture is absent. The existing wake
    // transaction cancels an uncommitted idle checkpoint, or serializes a
    // committed drain before fresh runtime admission is allowed.
    if (["ready", "busy"].includes(current.status)) {
      await wait(manageCloudWorkspace(target, "wake", false, reason));
      current = assertCurrent();
    }
    const deadline = Date.now() + 120_000;
    while (!["ready", "busy"].includes(current.status)) {
      if (current.status === "stopped" && mayWake) {
        mayWake = false;
        await wait(manageCloudWorkspace(target, "wake", false, reason));
        current = assertCurrent();
        continue;
      }
      if (!["stopping", "waking", "provisioning", "setting_up"].includes(current.status) ||
          (current.status === "stopping" && !mayWake))
        throw new CloudWorkspaceWakeEndedError(current.error?.message ?? `Cloud workspace is ${current.status}. Open it again to retry.`);
      if (Date.now() >= deadline)
        throw new Error("The cloud workspace is still starting. Open it again when it is ready.");
      await wait(new Promise<void>(resolve => { timer = setTimeout(resolve, 1_000); }));
      current = assertCurrent();
      if (["ready", "busy"].includes(current.status)) continue;
      await wait(refreshCloudWorkspace(target));
      current = assertCurrent();
    }
    return current;
  } finally {
    clearTimeout(timer);
    off();
    signal?.removeEventListener("abort", cancel);
  }
}
