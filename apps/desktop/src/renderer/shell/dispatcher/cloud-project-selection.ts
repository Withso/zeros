// Create's cloud project, remembered per (account, organization) the way the
// cloud repository was before projects. A route into Create from a project's
// workspace prefers that project; otherwise the last one chosen, while it is
// still listed, then the first.
import { useEffect, useState, useSyncExternalStore } from "react";
import type { CloudProject } from "../../platform/cloud-github-levels";

export const cloudProjectStorageKey = "zeros:cloud-project:v1";
const MAX_OWNERS = 128;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const validOwner = (key: unknown): key is string => {
  if (typeof key !== "string" || key.length > 100) return false;
  try {
    const value: unknown = JSON.parse(key);
    return Array.isArray(value) && value.length === 2 && value.every(id => typeof id === "string" && uuid.test(id));
  } catch { return false; }
};

export function parseCloudProjectSelections(raw: unknown): Map<string, string> {
  if (!Array.isArray(raw)) return new Map();
  return new Map(raw.filter((row): row is [string, string] => Array.isArray(row) && row.length === 2 && validOwner(row[0])
    && typeof row[1] === "string" && uuid.test(row[1])).slice(-MAX_OWNERS));
}
function read(): Map<string, string> {
  try { return parseCloudProjectSelections(JSON.parse(localStorage.getItem(cloudProjectStorageKey) ?? "null")); }
  catch { return new Map(); }
}
let selections: Map<string, string> | null = null;
const all = () => (selections ??= read());
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const inactive = () => () => {};

export function rememberCloudProject(owner: string, id: string | null): void {
  if (!validOwner(owner) || (id !== null && !uuid.test(id))) return;
  const map = all();
  if ((map.get(owner) ?? null) === id) return;
  map.delete(owner);
  if (id !== null) map.set(owner, id);
  while (map.size > MAX_OWNERS) map.delete(map.keys().next().value!);
  try { localStorage.setItem(cloudProjectStorageKey, JSON.stringify([...map])); } catch { /* Unavailable storage is non-fatal. */ }
  for (const listener of listeners) listener();
}

/** The project of a route into Create: a project's sidebar group names it, or a repository's names its one-repository project. */
export function cloudProjectIntent(intent: string | null | undefined, projects: readonly CloudProject[] | null | undefined): string | null {
  if (!intent || !projects) return null;
  const project = /^cloud-project:[^:]+:project:([0-9a-f-]{36})$/i.exec(intent)?.[1];
  if (project) return projects.some(row => row.id === project) ? project : null;
  const repository = /^cloud-repository:[^:]+:github\.com:(.+)$/i.exec(intent)?.[1]?.toLowerCase();
  if (!repository) return null;
  const single = projects.filter(row => row.repositories.length === 1 && row.repositories[0]!.repository === repository);
  return (single.find(row => row.level === "organization") ?? single[0])?.id ?? null;
}

export function useCloudProjectSelection(owner: string | null, projects: readonly CloudProject[] | null | undefined, active: boolean,
  preferredId: string | null = null, selectionIntent?: string | null) {
  const [picked, setPicked] = useState<{ context: string; id: string } | null>(null);
  const context = JSON.stringify([owner, selectionIntent]);
  useEffect(() => { if (!active) setPicked(null); }, [active]);
  const remembered = useSyncExternalStore(active && owner ? subscribe : inactive,
    () => (owner ? all().get(owner) ?? null : null), () => (owner ? all().get(owner) ?? null : null));
  const routed = cloudProjectIntent(selectionIntent, projects) ?? preferredId;
  const project = projects?.find(row => row.id === (picked?.context === context ? picked.id : routed))
    ?? projects?.find(row => row.id === remembered) ?? projects?.[0] ?? null;
  useEffect(() => {
    if (active && owner && projects != null) rememberCloudProject(owner, project?.id ?? null);
  }, [active, owner, projects, project?.id]);
  return {
    project,
    rememberedId: routed ?? remembered,
    select: (id: string) => {
      if (active && owner && projects?.some(row => row.id === id)) { setPicked({ context, id }); rememberCloudProject(owner, id); }
    },
  };
}
