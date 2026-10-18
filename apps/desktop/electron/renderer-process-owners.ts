/** Native renderer attribution. Only these product roles enter diagnostics;
 * page titles, URLs, conversation IDs and workspace paths are never labels. */
export type RendererProcessOwner =
  | "Main window"
  | "Browser tab"
  | "Browser preview"
  | "Design capture"
  | "Agent-control overlay";

interface RendererContents {
  isDestroyed(): boolean;
  getOSProcessId(): number;
  on(event: "destroyed", listener: () => void): unknown;
}

interface Registration {
  contents: WeakRef<RendererContents>;
  owner: RendererProcessOwner;
}

export class RendererProcessOwnerRegistry {
  private readonly entries = new Set<Registration>();
  private readonly byContents = new WeakMap<RendererContents, Registration>();

  track(contents: RendererContents, owner: RendererProcessOwner): void {
    const existing = this.byContents.get(contents);
    if (existing) { existing.owner = owner; return; }
    const entry: Registration = { contents: new WeakRef(contents), owner };
    this.entries.add(entry);
    this.byContents.set(contents, entry);
    contents.on("destroyed", () => {
      this.entries.delete(entry);
      const current = entry.contents.deref();
      if (current) this.byContents.delete(current);
    });
  }

  /** Resolve at observation time: navigation and crashes can replace a
   * WebContents' OS process without replacing its native owner. No polling or
   * process launch is needed, and the registry never retains a renderer. */
  ownersByPid(): Map<number, string> {
    const grouped = new Map<number, Set<RendererProcessOwner>>();
    for (const entry of this.entries) {
      const contents = entry.contents.deref();
      try {
        if (!contents || contents.isDestroyed()) {
          this.entries.delete(entry);
          if (contents) this.byContents.delete(contents);
          continue;
        }
        const pid = contents.getOSProcessId();
        if (!Number.isSafeInteger(pid) || pid <= 0) continue;
        const owners = grouped.get(pid) ?? new Set<RendererProcessOwner>();
        owners.add(entry.owner);
        grouped.set(pid, owners);
      } catch {
        // A renderer being created or torn down can temporarily have no PID.
      }
    }
    return new Map([...grouped].map(([pid, owners]) => [pid, [...owners].sort().join(", ")]));
  }
}

export const rendererProcessOwners = new RendererProcessOwnerRegistry();
