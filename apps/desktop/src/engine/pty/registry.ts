// ──────────────────────────────────────────────────────────
// TerminalRegistry — engine-owned shared-terminal bookkeeping
// ──────────────────────────────────────────────────────────
//
// Shared terminals: a PTY is an engine resource, not owned by one client. Local
// and approved remote clients can see and drive the same terminals, exactly
// like agent sessions. This registry holds the per-terminal metadata that drives
// two things:
//
//   1. The shared terminal LIST (PTY_LIST): a device that didn't create a
//      terminal can still discover + attach to it (deterministic sessionId →
//      same PtyService session). Scoped per client so a remote client only ever
//      sees terminals in a workspace it's allowed to.
//   2. The per-workspace restriction GATE on write/resize/kill: a remote client
//      may operate a terminal only when its workspace is shared (not on the
//      owner's remote-restriction list). Local desktop is the trusted operator
//      and bypasses the gate entirely.
//
// Replaces the old exclusive `ptyOwner` map. There is deliberately no per-client
// ownership: access is gated upstream by account binding + the restriction list,
// NOT by which device connected first, and terminals PERSIST across client
// disconnects.
//
// Pure data + pure predicates — no transport, no node-pty — so the gating and
// scoping rules are unit-testable without an engine harness.
// ──────────────────────────────────────────────────────────

export interface TerminalEntry {
  sessionId: string;
  /** The managed workspace this terminal belongs to, when known. null for a
   *  terminal whose workspace the engine couldn't determine (e.g. a legacy local
   *  caller that sent only a raw cwd) — treated as NON-shareable to remote
   *  devices (fail-closed). */
  workspaceId: string | null;
  /** Resolved host cwd the shell was spawned in (informational / display). */
  cwd: string;
  createdAt: number;
  /** True once the shell EXITED on its own (the user typed `exit`, the process
   *  died) but the terminal was NOT explicitly closed. The entry is kept so every
   *  device shows it as "(exited)" and can restart it in place; an explicit close
   *  (PTY_KILL) removes the entry entirely instead. Cleared when restarted. */
  exited?: boolean;
}

export class TerminalRegistry {
  private readonly entries = new Map<string, TerminalEntry>();

  /** Record a freshly-spawned terminal. Idempotent on sessionId (a reattach
   *  re-uses the same id and must not duplicate or reset the entry). Returns
   *  true when a NEW entry was added (so the caller can broadcast the change). */
  add(entry: TerminalEntry): boolean {
    if (this.entries.has(entry.sessionId)) return false;
    this.entries.set(entry.sessionId, entry);
    return true;
  }

  /** Drop a terminal (explicit close). Returns true when an entry was removed. */
  remove(sessionId: string): boolean {
    return this.entries.delete(sessionId);
  }

  /** Mark a terminal as exited-in-place (natural shell exit, kept + restartable).
   *  Returns true when the flag actually flipped (so the caller broadcasts). */
  markExited(sessionId: string): boolean {
    const t = this.entries.get(sessionId);
    if (!t || t.exited) return false;
    t.exited = true;
    return true;
  }

  /** Clear the exited flag when a terminal is restarted in place. Returns true
   *  when it actually flipped. */
  markAlive(sessionId: string): boolean {
    const t = this.entries.get(sessionId);
    if (!t || !t.exited) return false;
    t.exited = false;
    return true;
  }

  has(sessionId: string): boolean {
    return this.entries.has(sessionId);
  }
  get(sessionId: string): TerminalEntry | undefined {
    return this.entries.get(sessionId);
  }

  /** Session ids of terminals whose cwd is `folder` or nested inside it — the
   *  archive/delete reaper's target set (a shell left running in a removed
   *  worktree holds the directory open and confuses its removal). */
  idsUnderFolder(folder: string): string[] {
    const prefix = folder.endsWith("/") ? folder : folder + "/";
    const ids: string[] = [];
    for (const [id, t] of this.entries) {
      if (t.cwd === folder || t.cwd.startsWith(prefix)) ids.push(id);
    }
    return ids;
  }

  /** The terminals a client may SEE, oldest first. A remote client sees only
   *  terminals in a KNOWN, non-restricted workspace (fail-closed: an unknown
   *  workspace is hidden — never expose a shell we can't prove is shared); the
   *  local desktop sees everything. Optionally scoped to a single workspaceId. */
  visibleTo(opts: {
    isRemote: boolean;
    restricted: ReadonlySet<string>;
    workspaceId?: string;
  }): TerminalEntry[] {
    let list = [...this.entries.values()];
    if (opts.isRemote) {
      list = list.filter(
        (t) => t.workspaceId != null && !opts.restricted.has(t.workspaceId),
      );
    }
    if (opts.workspaceId) {
      list = list.filter((t) => t.workspaceId === opts.workspaceId);
    }
    return list.sort((a, b) => a.createdAt - b.createdAt);
  }

  /** Whether a remote client may operate (write/resize/kill) a terminal. Refused
   *  when the terminal is unknown, its workspace is unknown, or that workspace is
   *  remote-restricted (all fail-closed). Local clients are the trusted operator
   *  and the caller bypasses this for them. */
  remoteMayOperate(
    sessionId: string,
    restricted: ReadonlySet<string>,
  ): boolean {
    const t = this.entries.get(sessionId);
    if (!t || t.workspaceId == null) return false;
    return !restricted.has(t.workspaceId);
  }

  /** All live sessionIds (e.g. for teardown). */
  sessionIds(): string[] {
    return [...this.entries.keys()];
  }
  clear(): void {
    this.entries.clear();
  }
}
