// PTYs belong to the engine, not the device that opened them, so an authorized client can reattach after disconnect.

export interface TerminalEntry {
  sessionId: string;
  /** A terminal without verified workspace ownership is never shared remotely. */
  workspaceId: string | null;
  cwd: string;
  createdAt: number;
  /** Natural exit keeps the shared tab restartable; explicit close removes it. */
  exited?: boolean;
}

export class TerminalRegistry {
  private readonly entries = new Map<string, TerminalEntry>();

  /** Reattach must not reset the entry for an existing session ID. */
  add(entry: TerminalEntry): boolean {
    if (this.entries.has(entry.sessionId)) return false;
    this.entries.set(entry.sessionId, entry);
    return true;
  }

  remove(sessionId: string): boolean {
    return this.entries.delete(sessionId);
  }

  markExited(sessionId: string): boolean {
    const t = this.entries.get(sessionId);
    if (!t || t.exited) return false;
    t.exited = true;
    return true;
  }

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

  idsUnderFolder(folder: string): string[] {
    const prefix = folder.endsWith("/") ? folder : folder + "/";
    const ids: string[] = [];
    for (const [id, t] of this.entries) {
      if (t.cwd === folder || t.cwd.startsWith(prefix)) ids.push(id);
    }
    return ids;
  }

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

  /** The caller bypasses this for trusted local clients only; remote access requires a known, unrestricted workspace. */
  remoteMayOperate(
    sessionId: string,
    restricted: ReadonlySet<string>,
  ): boolean {
    const t = this.entries.get(sessionId);
    if (!t || t.workspaceId == null) return false;
    return !restricted.has(t.workspaceId);
  }

  sessionIds(): string[] {
    return [...this.entries.keys()];
  }
  clear(): void {
    this.entries.clear();
  }
}
