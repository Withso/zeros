/** R1 catalog-events-v1: the account events stream (Electron main) reports every cloud workspace change. While its
 * ready frame announces the feature the catalog refreshes on those events, on ready, and otherwise every 60 s; a stream
 * without it, or none, keeps today's 30 s (2 s while a lifecycle is pending). */
export function catalogRefreshDelayMs(catalogEvents: boolean, lifecyclePending: boolean): number {
  return catalogEvents ? 60_000 : lifecyclePending ? 2_000 : 30_000;
}

type Listen = (name: string, handler: (payload: unknown) => void) => Promise<() => void>;

export function watchCloudCatalogEvents(listen: Listen, on: { refresh(): void; modeChanged(): void }): { active(): boolean; stop(): void } {
  let active = false, stopped = false;
  const offs: Array<() => void> = [];
  const subscribe = (name: string, handler: (payload: unknown) => void) => {
    void listen(name, handler).then(off => { if (stopped) off(); else offs.push(off); }, () => {});
  };
  subscribe("cloud-catalog-stream", payload => {
    const next = (payload as { catalogEvents?: unknown } | null)?.catalogEvents === true;
    if (next === active) return;
    active = next;
    on.modeChanged();
    // A new ready may follow a gap: refresh once now.
    if (active) on.refresh();
  });
  subscribe("cloud-catalog-changed", payload => {
    const change = payload as { organizationId?: unknown; workspaceId?: unknown } | null;
    if (active && typeof change?.organizationId === "string" && typeof change.workspaceId === "string") on.refresh();
  });
  return { active: () => active, stop: () => { stopped = true; for (const off of offs.splice(0)) off(); } };
}
