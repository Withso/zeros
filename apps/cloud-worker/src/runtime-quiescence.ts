const CATEGORIES = ["clients", "requests", "agents", "terminals", "setup", "checkout", "configuration", "prompts", "attachments", "storage", "tools"] as const;
export type RuntimeCensus = Record<typeof CATEGORIES[number], boolean | null>;
export type QuietTicket = { generation: number };

/** Idle-stop deliberately tolerates shells and pending input. Runtime adoption
 * requires a separate complete census, and activity between samples fences it. */
export class RuntimeQuiescence {
  private generation = 0;
  private quietSince?: number;
  private phase: "open" | "sealing" | "committed" = "open";
  private pending = 0;
  private wait?: Promise<void>;
  private resume?: () => void;

  constructor(private readonly census: () => RuntimeCensus, private readonly now: () => number = Date.now) {}

  get open(): boolean { return this.phase === "open"; }

  activity(): void { this.generation++; this.quietSince = undefined; }
  private quiet(): boolean {
    const census = this.census();
    return this.pending === 0 && CATEGORIES.every(key => census[key] === false);
  }
  ticket(): QuietTicket | null {
    if (this.phase !== "open" || !this.quiet()) { this.quietSince = undefined; return null; }
    this.quietSince ??= this.now();
    return this.now() - this.quietSince >= 30_000 ? { generation: this.generation } : null;
  }
  valid(ticket: QuietTicket): boolean { return ticket.generation === this.generation && this.quiet(); }
  freeze(ticket: QuietTicket): boolean {
    if (this.phase !== "open" || !this.valid(ticket)) return false;
    this.phase = "sealing";
    this.wait = new Promise(resolve => { this.resume = resolve; });
    return true;
  }
  commit(ticket: QuietTicket): boolean {
    if (this.phase !== "sealing" || !this.valid(ticket)) return false;
    this.phase = "committed"; return true;
  }
  admit(): (() => void) | Promise<() => void> {
    if (this.phase !== "committed") this.activity();
    if (this.phase !== "open") return this.wait!.then(() => this.admit());
    this.activity(); this.pending++;
    let released = false;
    return () => {
      if (released) return;
      released = true; this.pending--; this.activity();
      if (this.quiet()) this.quietSince = this.now();
    };
  }
  release(): void {
    this.phase = "open"; this.activity();
    this.resume?.(); this.resume = undefined; this.wait = undefined;
  }
}
