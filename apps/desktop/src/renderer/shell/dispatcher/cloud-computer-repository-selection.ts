import { useEffect, useState, useSyncExternalStore } from "react";
import type { CloudComputerRepository } from "../../features/settings/cloud-computer-v2-create-gate";

export const computerRepositoryStorageKey =
  "zeros:cloud-computer-repository:v1";
const MAX_OWNERS = 128;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A lowercase owner/name. Numeric ids written by the retired v1 Computer are
 * dropped on read. */
const repositoryId = /^[a-z0-9_.-]{1,100}\/[a-z0-9_.-]{1,100}$/;
function validOwner(key: unknown): key is string {
  if (typeof key !== "string" || key.length > 100) return false;
  try {
    const value: unknown = JSON.parse(key);
    return (
      Array.isArray(value) &&
      value.length === 2 &&
      value.every((id) => typeof id === "string" && uuid.test(id))
    );
  } catch {
    return false;
  }
}
export function parseComputerRepositorySelections(
  raw: unknown,
): Map<string, string> {
  if (!Array.isArray(raw)) return new Map();
  return new Map(
    raw
      .filter(
        (row): row is [string, string] =>
          Array.isArray(row) &&
          row.length === 2 &&
          validOwner(row[0]) &&
          typeof row[1] === "string" &&
          repositoryId.test(row[1]),
      )
      .slice(-MAX_OWNERS),
  );
}
function readSelections() {
  try {
    return parseComputerRepositorySelections(
      JSON.parse(localStorage.getItem(computerRepositoryStorageKey) ?? "null"),
    );
  } catch {
    return new Map<string, string>();
  }
}
const selections = readSelections();
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
const inactiveSubscribe = () => () => {};

export function rememberComputerRepository(
  owner: string,
  id: string | null,
): void {
  if (!validOwner(owner) || (id !== null && !repositoryId.test(id)))
    return;
  if ((selections.get(owner) ?? null) === id) return;
  selections.delete(owner);
  if (id !== null) selections.set(owner, id);
  while (selections.size > MAX_OWNERS)
    selections.delete(selections.keys().next().value!);
  try {
    localStorage.setItem(
      computerRepositoryStorageKey,
      JSON.stringify([...selections]),
    );
  } catch {
    /* Unavailable storage is non-fatal. */
  }
  for (const listener of listeners) listener();
}

export function useComputerRepositorySelection(
  owner: string | null,
  repositories: readonly CloudComputerRepository[] | null | undefined,
  active: boolean,
  preferredId: string | null = null,
  selectionIntent?: string | null,
) {
  const [picked, setPicked] = useState<{ context: string; id: string } | null>(null);
  const context = JSON.stringify([owner, selectionIntent]);
  useEffect(() => { if (!active) setPicked(null); }, [active]);
  const remembered = useSyncExternalStore(
    active && owner ? subscribe : inactiveSubscribe,
    () => (owner ? (selections.get(owner) ?? null) : null),
    () => (owner ? (selections.get(owner) ?? null) : null),
  );
  // The exact owner's authoritative list determines the first paint. A cold
  // read cannot invalidate a remembered repository or select another owner.
  const repository =
    repositories?.find((row) => row.id === (picked?.context === context ? picked.id : preferredId)) ??
    repositories?.find((row) => row.id === remembered) ??
    repositories?.[0] ??
    null;
  useEffect(() => {
    if (active && owner && repositories != null)
      rememberComputerRepository(owner, repository?.id ?? null);
  }, [active, owner, repositories, repository?.id]);
  return {
    repository,
    rememberedId: preferredId ?? remembered,
    select: (id: string) => {
      if (active && owner && repositories?.some((row) => row.id === id)) {
        setPicked({ context, id });
        rememberComputerRepository(owner, id);
      }
    },
  };
}
