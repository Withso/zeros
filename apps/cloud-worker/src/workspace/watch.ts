import { watch, type FSWatcher } from "node:fs";
import { dirname } from "node:path";
import type { CommandRunner } from "./commands";
import type { WorkspaceScope } from "./scope";

/** Watch only directories Git exposes to the UI, bounded independently of
 * ignored dependency trees. HEAD polling also catches packed/external refs. */
export class CheckoutWatch {
  private readonly watchers = new Map<string, FSWatcher>();
  private timer?: ReturnType<typeof setTimeout>;
  private heartbeat?: ReturnType<typeof setInterval>;
  private pending = Promise.resolve();
  private disposed = false;
  private refresh = false;
  constructor(private readonly scope: WorkspaceScope, private readonly run: CommandRunner, private readonly changed: (content: boolean) => Promise<void>) {}

  async start(): Promise<void> {
    await this.scan();
    this.heartbeat = setInterval(() => this.schedule(false), 3000); this.heartbeat.unref?.();
  }
  schedule(content = true): void {
    if (this.disposed) return;
    this.refresh ||= content;
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = undefined; this.drain(); }, 100); this.timer.unref?.();
  }
  private drain(): void {
    const content = this.refresh; this.refresh = false;
    this.pending = this.pending.then(async () => {
      if (this.disposed) return;
      if (content) await this.scan();
      await this.changed(content);
    }).catch(() => {});
  }
  async flush(): Promise<void> {
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; this.drain(); }
    await this.pending;
  }
  async dispose(): Promise<void> {
    this.disposed = true; clearTimeout(this.timer); clearInterval(this.heartbeat);
    for (const watcher of this.watchers.values()) watcher.close(); this.watchers.clear();
    await this.pending;
  }
  private async scan(): Promise<void> {
    const paths = new Set([this.scope.root]);
    try {
      const [files, gitDir] = await Promise.all([
        this.run("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { readOnly: true }),
        this.run("git", ["rev-parse", "--absolute-git-dir"], { readOnly: true }),
      ]);
      if (gitDir.stdout.trim()) paths.add(gitDir.stdout.trim());
      for (const file of files.stdout.split("\0").filter(Boolean)) {
        let path = dirname(this.scope.path(file));
        while (path !== this.scope.root && paths.size < 2048) { paths.add(path); path = dirname(path); }
      }
    } catch { /* HEAD polling remains available while a checkout is unavailable. */ }
    if (this.disposed) return;
    for (const [path, watcher] of this.watchers) if (!paths.has(path)) { watcher.close(); this.watchers.delete(path); }
    for (const path of paths) {
      if (this.watchers.has(path)) continue;
      try {
        const watcher = watch(path, { persistent: false }, () => this.schedule(true));
        watcher.on("error", () => { watcher.close(); this.watchers.delete(path); });
        this.watchers.set(path, watcher);
      } catch { /* Missing/raced directories are retried on the next change. */ }
    }
  }
}
