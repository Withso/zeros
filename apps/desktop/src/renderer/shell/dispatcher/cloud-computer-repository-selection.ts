import { useEffect, useSyncExternalStore } from "react";
import type { CloudComputerV2ActiveRepository } from "@zeros/protocol/cloud-computer-v2";

export const computerRepositoryStorageKey =
  "zeros:cloud-computer-repository:v1";
const MAX_OWNERS = 128;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
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
          /^[1-9][0-9]{0,39}$/.test(row[1]),
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
  if (!validOwner(owner) || (id !== null && !/^[1-9][0-9]{0,39}$/.test(id)))
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
  repositories: CloudComputerV2ActiveRepository[] | undefined,
  active: boolean,
) {
  const remembered = useSyncExternalStore(
    active && owner ? subscribe : inactiveSubscribe,
    () => (owner ? (selections.get(owner) ?? null) : null),
    () => (owner ? (selections.get(owner) ?? null) : null),
  );
  // The exact owner's authoritative list determines the first paint. A cold
  // read cannot invalidate a remembered repository or select another owner.
  const repository =
    repositories?.find((row) => row.id === remembered) ??
    repositories?.[0] ??
    null;
  useEffect(() => {
    if (active && owner && repositories !== undefined)
      rememberComputerRepository(owner, repository?.id ?? null);
  }, [active, owner, repositories, repository?.id]);
  return {
    repository,
    select: (id: string) => {
      if (active && owner && repositories?.some((row) => row.id === id))
        rememberComputerRepository(owner, id);
    },
  };
}
