import { ghPrList } from "../../platform/git";
import { cloudTargetForValue, cloudWorkspaceKey } from "../../platform/bridge/cloud-workspace-key";
import { composerPrsCache, composerPrsKey } from "../../state/read-caches";

const FRESH_MS = 30_000;

/** One active picker subscription per composer; inactive pickers retain only
 * bounded exact-owner snapshots and never fetch on reconnect or account changes. */
export class ComposerPrSearch {
  private key: string | null = null;
  private unsubscribe: (() => void) | undefined;

  constructor(private readonly notify: () => void) {}

  snapshot(cwd: string | null, originUrl: string | null) {
    return originUrl ? composerPrsCache.getSnapshot(composerPrsKey(cwd, originUrl)) : null;
  }

  search(cwd: string | null, originUrl: string | null): void {
    const key = originUrl ? composerPrsKey(cwd, originUrl) : null;
    if (key === this.key) return;
    this.clear();
    this.key = key;
    if (!key || !originUrl) return;
    let version = composerPrsCache.getSnapshot(key).invalidationVersion;
    this.unsubscribe = composerPrsCache.subscribe(key, () => {
      if (composerPrsKey(cwd, originUrl) !== key) {
        this.clear();
        this.notify();
        return;
      }
      const next = composerPrsCache.getSnapshot(key).invalidationVersion;
      if (next !== version) {
        version = next;
        this.request(key);
      }
      this.notify();
    });
    this.request(key);
  }

  clear(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.key = null;
  }

  private request(key: string): void {
    void composerPrsCache.load(key, async () => {
      const [, cwd, originUrl] = JSON.parse(key) as [number | null, string | null, string];
      if (composerPrsKey(cwd, originUrl) !== key) throw new Error("Cloud account changed");
      const target = cloudTargetForValue(cwd);
      return ghPrList({ ...(target ? { workspaceId: cloudWorkspaceKey(target) } : {}), originUrl, state: "open" });
    }, { maxAgeMs: FRESH_MS }).catch(() => {});
  }
}
