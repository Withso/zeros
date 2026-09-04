import { cloudWorkspaceDesktopCapabilityEnabled } from "../src/engine/cloud-workspace-capability";

type RefreshTimer = ReturnType<typeof setInterval>;

export function seedCloudReplicaSessionToEngineIfEnabled(options: {
  push: () => Promise<void>;
  capabilityEnabled?: () => boolean;
}): boolean {
  const enabled =
    options.capabilityEnabled ?? cloudWorkspaceDesktopCapabilityEnabled;
  if (!enabled()) return false;
  void options.push();
  return true;
}

/** Install the bearer refresh loop only in a release-enabled desktop. */
export function startCloudReplicaSessionRefresh(options: {
  refresh: () => Promise<void>;
  onError?: (error: unknown) => void;
  capabilityEnabled?: () => boolean;
  schedule?: (callback: () => void, intervalMs: number) => RefreshTimer;
  cancel?: (timer: RefreshTimer) => void;
  intervalMs?: number;
}): () => void {
  const enabled =
    options.capabilityEnabled ?? cloudWorkspaceDesktopCapabilityEnabled;
  if (!enabled()) return () => undefined;

  const schedule = options.schedule ?? setInterval;
  const cancel = options.cancel ?? clearInterval;
  const timer = schedule(() => {
    void options.refresh().catch((error: unknown) => options.onError?.(error));
  }, options.intervalMs ?? 45_000);
  timer.unref?.();
  return () => cancel(timer);
}
