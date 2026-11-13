/** R1 catalog-events-v1: the account events stream (Electron main) reports every cloud workspace change. While its
 * ready frame announces the feature the catalog refreshes on those events, on ready, and otherwise every 60 s; a stream
 * without it, or none, keeps today's 30 s (2 s while a lifecycle is pending). */
export function catalogRefreshDelayMs(catalogEvents: boolean, lifecyclePending: boolean): number {
  return catalogEvents ? 60_000 : lifecyclePending ? 2_000 : 30_000;
}

type Listen = (name: string, handler: (payload: unknown) => void) => Promise<() => void>;

/** At most one catalog read per burst of change hints: the first hint waits this long to gather the burst; hints that
 * arrive while a read is in flight give one trailing read this long after it ends. */
export const CATALOG_HINT_COALESCE_MS = 1_000;

export function watchCloudCatalogEvents(listen: Listen, on: { refresh(): Promise<void> | void; modeChanged(): void }): { active(): boolean; stop(): void } {
  let active = false, stopped = false;
  const offs: Array<() => void> = [];
  let timer: ReturnType<typeof setTimeout> | undefined, reading = false, again = false;
  const read = () => {
    timer = undefined;
    if (stopped) return;
    reading = true;
    let result: Promise<void> | void;
    try { result = on.refresh(); } catch { result = undefined; }
    void Promise.resolve(result).catch(() => {}).finally(() => {
      reading = false;
      if (again && !stopped) { again = false; arm(); }
    });
  };
  const arm = () => { if (timer === undefined && !stopped) timer = setTimeout(read, CATALOG_HINT_COALESCE_MS); };
  const hint = () => { if (stopped) return; if (reading) again = true; else arm(); };
  /** The stream's ready may follow a gap: read now unless one is already in flight (then once after it). */
  const now = () => { if (stopped) return; if (reading) { again = true; return; } clearTimeout(timer); read(); };
  const subscribe = (name: string, handler: (payload: unknown) => void) => {
    void listen(name, handler).then(off => { if (stopped) off(); else offs.push(off); }, () => {});
  };
  subscribe("cloud-catalog-stream", payload => {
    const next = (payload as { catalogEvents?: unknown } | null)?.catalogEvents === true;
    if (next === active) return;
    active = next;
    on.modeChanged();
    if (active) now();
  });
  subscribe("cloud-catalog-changed", payload => {
    const change = payload as { organizationId?: unknown; workspaceId?: unknown } | null;
    if (active && typeof change?.organizationId === "string" && typeof change.workspaceId === "string") hint();
  });
  return { active: () => active, stop: () => { stopped = true; clearTimeout(timer); timer = undefined; for (const off of offs.splice(0)) off(); } };
}
