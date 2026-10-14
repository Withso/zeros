import { useSyncExternalStore } from "react";
import { cloudWorkspaceExecutionRefusal } from "../platform/cloud-workspace-execution";
import { cloudWorkspaceDocument, refreshCloudWorkspace, subscribeCloudWorkspaces } from "./cloud-workspace-catalog";
import { cloudRuntimeUpgradeAvailability, cloudRuntimeUpgradeAvailabilityKey, loadCloudRuntimeUpgradeAvailability } from "./cloud-runtime-upgrade";

const visible = () => typeof document === "undefined" || document.visibilityState !== "hidden";
const inert = () => () => {};
const subscribeVisibility = (listener: () => void) => {
  if (typeof document === "undefined") return inert();
  document.addEventListener("visibilitychange", listener);
  return () => document.removeEventListener("visibilitychange", listener);
};
export function useRuntimeUpgradeDocumentVisible(active: boolean): boolean {
  return useSyncExternalStore(active ? subscribeVisibility : inert, visible, visible) && active;
}

const progressStates = new Set(["draining", "provisioning", "setting_up", "rolling_back"]);
const startingStates = new Set(["waking", "provisioning", "setting_up"]);
const stableIntervalMs = 30_000;
type Observation = { add: (details: boolean) => () => void };
const observations = new Map<string, Observation>();

/** One timer/flight for every visible exact-key consumer. The existing cache
 * keeps data and request-generation fences; this owns only passive observation. */
export function observeCloudRuntimeUpgradeAvailability(key: string, details = false): () => void {
  let observation = observations.get(key);
  if (!observation) {
    observation = createObservation(key);
    observations.set(key, observation);
  }
  return observation.add(details);
}

function createObservation(key: string): Observation {
  const [, , organizationId, workspaceId, generation] = JSON.parse(key) as [number, number, string, string, number];
  const target = { organizationId, workspaceId };
  const consumers = new Set<{ details: boolean }>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending = false, retired = false, initialized = false;
  let lastStarted: number | undefined;
  let cachePending = false;
  const current = () => {
    const doc = cloudWorkspaceDocument(target);
    return !retired && key === cloudRuntimeUpgradeAvailabilityKey(target, generation) &&
      doc?.placement === "cloud" && doc.generation.number === generation && doc.deletedAt === null &&
      !["deleting", "deleted"].includes(doc.status) && doc.capabilities.canManage && !cloudWorkspaceExecutionRefusal(doc)
      ? doc : null;
  };
  const hasDetails = () => [...consumers].some(consumer => consumer.details);
  const interval = () => {
    if (!hasDetails()) return stableIntervalMs;
    const transition = cloudRuntimeUpgradeAvailability.peekSnapshot(key).data?.transition;
    // Preserve the existing transition and VM-startup observation cadences.
    if (transition && progressStates.has(transition.state)) return 2_000;
    return startingStates.has(current()?.status ?? "") ? 5_000 : stableIntervalMs;
  };
  const clearTimer = () => { clearTimeout(timer); timer = undefined; };
  const retire = () => {
    if (retired) return;
    retired = true; clearTimer(); offCache(); offCatalog(); offVisibility();
    if (typeof window !== "undefined") window.removeEventListener("focus", foreground);
    if (observations.get(key) === observation) observations.delete(key);
  };
  const schedule = () => {
    clearTimer();
    if (!current()) { retire(); return; }
    const snapshot = cloudRuntimeUpgradeAvailability.peekSnapshot(key);
    if (!consumers.size || pending || !visible() || snapshot.loading || snapshot.refreshing) return;
    timer = setTimeout(() => { timer = undefined; read(true); }, Math.max(0, (lastStarted ?? performance.now()) + interval() - performance.now()));
  };
  const read = (force: boolean) => {
    clearTimer();
    if (!current()) { retire(); return; }
    if (!consumers.size || pending || !visible()) return;
    pending = true; lastStarted = performance.now();
    const reads: Promise<unknown>[] = [cloudRuntimeUpgradeAvailability.load(key, () => loadCloudRuntimeUpgradeAvailability(key), { force, maxAgeMs: 10_000 })];
    if (force && interval() < stableIntervalMs) reads.push(refreshCloudWorkspace(target));
    void Promise.allSettled(reads).then(() => { pending = false; schedule(); });
  };
  const foreground = () => {
    clearTimer();
    if (!current()) { retire(); return; }
    const snapshot = cloudRuntimeUpgradeAvailability.peekSnapshot(key);
    if (!visible() || pending || snapshot.loading || snapshot.refreshing) return;
    if (lastStarted === undefined) read(false);
    else if (performance.now() - lastStarted >= Math.min(10_000, interval())) read(true);
    else schedule();
  };
  const offVisibility = subscribeVisibility(foreground);
  if (typeof window !== "undefined") window.addEventListener("focus", foreground);
  const offCatalog = subscribeCloudWorkspaces(schedule);
  const offCache = cloudRuntimeUpgradeAvailability.subscribe(key, () => {
    const snapshot = cloudRuntimeUpgradeAvailability.peekSnapshot(key);
    const loading = snapshot.loading || snapshot.refreshing;
    // An intent or invalidation can start a cache flight outside this observer.
    // Its start owns the next deadline too; completion must not cause a duplicate.
    if (loading && !cachePending && !pending) lastStarted = performance.now();
    cachePending = loading;
    schedule();
  });
  const observation: Observation = {
    add(details) {
      const consumer = { details }; consumers.add(consumer);
      if (!initialized) { initialized = true; read(false); }
      else schedule();
      return () => {
        consumers.delete(consumer);
        if (!consumers.size) retire();
        else schedule();
      };
    },
  };
  return observation;
}
