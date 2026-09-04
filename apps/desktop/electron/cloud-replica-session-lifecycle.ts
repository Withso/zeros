import { cloudWorkspaceDesktopCapabilityEnabled } from "../src/engine/cloud-workspace-capability";

type RefreshTimer = ReturnType<typeof setInterval>;

export type CloudReplicaSessionWriterWarning =
  | "session_read_failed"
  | "session_write_failed";

/** Own every asynchronous host→engine cloud-session publication. Reads may
 * overlap so a logout is never stuck behind an older token refresh, while the
 * generation check and write tail ensure only the newest result reaches the
 * exact child that requested it. */
export class CloudReplicaSessionWriter<Target extends object> {
  private generation = 0;
  private writeTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly options: {
      createLine: () => Promise<string>;
      signedOutLine: string;
      getTarget: () => Target | null;
      write: (target: Target, line: string) => void;
      onWarning?: (reason: CloudReplicaSessionWriterWarning) => void;
    },
  ) {}

  /** Invalidate every outstanding read synchronously, even when no engine is
   * currently available. */
  invalidate(): void {
    this.generation += 1;
  }

  push(): Promise<void> {
    const generation = ++this.generation;
    const target = this.options.getTarget();
    if (!target) return Promise.resolve();
    return this.resolveLine().then((line) =>
      this.enqueueWrite(generation, target, line),
    );
  }

  private async resolveLine(): Promise<string> {
    try {
      return await this.options.createLine();
    } catch {
      this.options.onWarning?.("session_read_failed");
      return this.options.signedOutLine;
    }
  }

  private enqueueWrite(
    generation: number,
    target: Target,
    line: string,
  ): Promise<void> {
    const write = () => {
      if (
        generation !== this.generation ||
        this.options.getTarget() !== target
      ) {
        return;
      }
      try {
        this.options.write(target, line);
      } catch {
        this.options.onWarning?.("session_write_failed");
      }
    };
    const pending = this.writeTail.then(write, write);
    this.writeTail = pending.catch(() => undefined);
    return pending;
  }
}

export function seedCloudReplicaSessionToEngineIfEnabled(options: {
  push: () => Promise<void>;
  onError?: (error: unknown) => void;
  capabilityEnabled?: () => boolean;
}): boolean {
  const enabled =
    options.capabilityEnabled ?? cloudWorkspaceDesktopCapabilityEnabled;
  if (!enabled()) return false;
  try {
    void options.push().catch((error: unknown) => options.onError?.(error));
  } catch (error) {
    options.onError?.(error);
  }
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
