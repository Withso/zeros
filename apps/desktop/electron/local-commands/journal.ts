import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import type { LocalCommandOutcome } from "@zeros/protocol/local-commands";

type State = "prompted" | "approved" | "running" | "done";
interface Entry { state: State; at: number; outcome?: LocalCommandOutcome }
const KEEP_MS = 7 * 24 * 3600_000, MAX_ENTRIES = 500;
const ACCOUNT = /^[A-Za-z0-9_-]{1,128}$/, REQUEST = /^[A-Za-z0-9_.:-]{1,256}$/;
const ORDER: Record<State, number> = { prompted: 0, approved: 1, running: 2, done: 3 };

/** This Mac's record of every local command request it has seen, per signed-in
 * account. Each step is durable before it takes effect, so a request that was
 * approved or started is never run again after a crash or restart. It holds
 * request ids and states only, never commands or output. */
export class LocalCommandJournal {
  private constructor(private readonly path: string, private readonly entries: Map<string, Entry>, private readonly now: () => number) {}

  static async open(root: string, accountId: string, now: () => number = Date.now): Promise<LocalCommandJournal> {
    if (!ACCOUNT.test(accountId)) throw new Error("Invalid account for the local command journal.");
    const directory = join(root, "local-commands");
    await mkdir(directory, { recursive: true, mode: 0o700 }); await chmod(directory, 0o700);
    const path = join(directory, `${createHash("sha256").update(accountId).digest("hex")}.json`);
    const raw = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error; });
    const entries = new Map<string, Entry>();
    if (raw !== undefined) {
      // Unreadable means unknown: refuse to start rather than forget a started request.
      const value = JSON.parse(raw) as { version?: unknown; entries?: Record<string, Entry> };
      if (value.version !== 1 || !value.entries || typeof value.entries !== "object") throw new Error("The local command journal is unreadable.");
      for (const [id, entry] of Object.entries(value.entries)) {
        if (!REQUEST.test(id) || !(entry?.state in ORDER) || !Number.isFinite(entry.at)) throw new Error("The local command journal is unreadable.");
        entries.set(id, entry);
      }
    }
    return new LocalCommandJournal(path, entries, now);
  }

  get size(): number { return this.entries.size; }
  state(requestId: string): State | undefined { return this.entries.get(requestId)?.state; }
  outcome(requestId: string): LocalCommandOutcome | undefined { return this.entries.get(requestId)?.outcome; }

  /** First sight of a request on this Mac. False when it was ever seen before. */
  async begin(requestId: string): Promise<boolean> {
    if (!REQUEST.test(requestId)) throw new Error("Invalid local command request id.");
    if (this.entries.has(requestId)) return false;
    this.entries.set(requestId, { state: "prompted", at: this.now() });
    await this.save();
    return true;
  }

  /** Steps only forward; a repeated or backward step is refused. */
  async mark(requestId: string, state: "approved" | "running"): Promise<void> {
    const entry = this.entries.get(requestId);
    if (!entry || ORDER[state] !== ORDER[entry.state] + 1) throw new Error("Out-of-order local command step.");
    this.entries.set(requestId, { state, at: this.now() });
    await this.save();
  }

  async finish(requestId: string, outcome: LocalCommandOutcome): Promise<void> {
    const entry = this.entries.get(requestId);
    if (!entry || entry.state === "done") return;
    this.entries.set(requestId, { state: "done", at: this.now(), outcome });
    await this.save();
  }

  /** Requests a previous run of the app approved or started without finishing. */
  recover(): Array<{ requestId: string; outcome: "interrupted" }> {
    return [...this.entries].filter(([, entry]) => entry.state === "approved" || entry.state === "running").map(([requestId]) => ({ requestId, outcome: "interrupted" as const }));
  }

  private async save(): Promise<void> {
    const cutoff = this.now() - KEEP_MS;
    for (const [id, entry] of this.entries) if (entry.state === "done" && entry.at < cutoff) this.entries.delete(id);
    if (this.entries.size > MAX_ENTRIES) {
      const done = [...this.entries].filter(([, entry]) => entry.state === "done").sort((a, b) => a[1].at - b[1].at);
      for (const [id] of done.slice(0, this.entries.size - MAX_ENTRIES)) this.entries.delete(id);
    }
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      const file = await open(temporary, "wx", 0o600);
      try { await file.writeFile(JSON.stringify({ version: 1, entries: Object.fromEntries(this.entries) })); await file.sync(); } finally { await file.close(); }
      await rename(temporary, this.path);
      const directory = await open(join(this.path, ".."), "r");
      try { await directory.sync(); } finally { await directory.close(); }
    } finally { await rm(temporary, { force: true }); }
  }
}
