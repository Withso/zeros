import { getSetting, setSetting } from "../../platform/settings";

const KEY = "settings:organization-selections:v1";
const MAX_OWNERS = 64;
type Selection = "section" | "provider";
type Entry = { owner: string; section?: string; provider?: string };
const legacyKeys: Record<Selection, string> = {
  section: "settings:active-section",
  provider: "providers:active-tab",
};

export function settingsOwnerKey(
  userId: string,
  organizationId: string | null,
): string {
  return organizationId ? JSON.stringify([userId, organizationId]) : "local";
}

function entries(): Entry[] {
  const value = getSetting<unknown>(KEY, []);
  return Array.isArray(value)
    ? value
        .filter(
          (entry): entry is Entry =>
            entry &&
            typeof entry === "object" &&
            typeof entry.owner === "string" &&
            entry.owner.length <= 512 &&
            (entry.section === undefined ||
              (typeof entry.section === "string" &&
                entry.section.length <= 256)) &&
            (entry.provider === undefined ||
              (typeof entry.provider === "string" &&
                entry.provider.length <= 64)),
        )
        .slice(-MAX_OWNERS)
    : [];
}

/** Navigation preferences only. Organization configuration never lives here. */
export function readScopedSettingsSelection(
  owner: string,
  kind: Selection,
  fallback: string,
): string {
  const value =
    owner === "local"
      ? getSetting<unknown>(legacyKeys[kind], fallback)
      : entries().find((entry) => entry.owner === owner)?.[kind];
  return typeof value === "string" ? value : fallback;
}

export function writeScopedSettingsSelection(
  owner: string,
  kind: Selection,
  value: string,
): void {
  if (owner === "local") {
    setSetting(legacyKeys[kind], value);
    return;
  }
  const current = entries();
  const entry = current.find((item) => item.owner === owner);
  setSetting(
    KEY,
    [
      ...current.filter((item) => item.owner !== owner),
      { ...entry, owner, [kind]: value },
    ].slice(-MAX_OWNERS),
  );
}

export function pruneScopedSettingsSelections(
  userId: string,
  organizationIds: readonly string[],
): void {
  const allowed = new Set(
    organizationIds.map((id) => settingsOwnerKey(userId, id)),
  );
  setSetting(
    KEY,
    entries().filter((entry) => {
      try {
        const owner: unknown = JSON.parse(entry.owner);
        return (
          Array.isArray(owner) &&
          owner.length === 2 &&
          (owner[0] !== userId || allowed.has(entry.owner))
        );
      } catch {
        return false;
      }
    }),
  );
}
