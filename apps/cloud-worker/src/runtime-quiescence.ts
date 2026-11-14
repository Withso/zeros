const CATEGORIES = ["clients", "requests", "agents", "terminals", "setup", "checkout", "configuration", "prompts", "attachments", "storage", "tools"] as const;
export type RuntimeCensus = Record<typeof CATEGORIES[number], boolean | null>;
/** runtime: an in-place runtime handoff needs the complete census. recovery (recovery-quiesce-v1): a replacement VM loses
 * attached clients and terminals by design, so only turns, setup and writes must be quiet, and terminal output is not
 * activity. */
export type QuietScope = "runtime" | "recovery";
export type QuietTicket = { generation: number; scope?: QuietScope };
const RECOVERY_IGNORES: ReadonlySet<string> = new Set(["clients", "terminals"]);

/** Idle-stop deliberately tolerates shells and pending input. Runtime adoption
 * requires a separate complete census, and activity between samples fences it. */
export class RuntimeQuiescence {
  private generation = 0;
  private workGeneration = 0;
  private quietSince: Partial<Record<QuietScope, number>> = {};
  private phase: "open" | "sealing" | "committed" = "open";
  private pending = 0;
  private wait?: Promise<void>;
  private resume?: () => void;

  constructor(private readonly census: () => RuntimeCensus, private readonly now: () => number = Date.now) {}

  get open(): boolean { return this.phase === "open"; }

  /** Terminal output fences a runtime handoff but not a recovery. */
  activity(source?: "terminal"): void {
    this.generation++; this.quietSince.runtime = undefined;
    if (source !== "terminal") { this.workGeneration++; this.quietSince.recovery = undefined; }
  }
  private quiet(scope: QuietScope = "runtime"): boolean {
    const census = this.census();
    return this.pending === 0 && CATEGORIES.every(key => (scope === "recovery" && RECOVERY_IGNORES.has(key)) || census[key] === false);
  }
  private current(scope: QuietScope): number { return scope === "recovery" ? this.workGeneration : this.generation; }
  ticket(scope: QuietScope = "runtime"): QuietTicket | null {
    if (this.phase !== "open" || !this.quiet(scope)) { this.quietSince[scope] = undefined; return null; }
    const since = this.quietSince[scope] ??= this.now();
    return this.now() - since >= 30_000 ? { generation: this.current(scope), ...(scope === "recovery" ? { scope } : {}) } : null;
  }
  valid(ticket: QuietTicket): boolean {
    const scope = ticket.scope ?? "runtime";
    return ticket.generation === this.current(scope) && this.quiet(scope);
  }
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
      for (const scope of ["runtime", "recovery"] as const) if (this.quiet(scope)) this.quietSince[scope] = this.now();
    };
  }
  release(): void {
    this.phase = "open"; this.activity();
    this.resume?.(); this.resume = undefined; this.wait = undefined;
  }
}
