import { z } from "zod";
import {
  browserSubscriptionProviderSchema,
  providerUsageSnapshotSchema,
  type BrowserSubscriptionProvider,
  type ProviderUsageSnapshot,
} from "@zeros/protocol/provider-auth";
import { getSetting, setSetting } from "../../platform/settings";

// Device-local cache, outside synced personal preferences. Only normalized
// display data is persisted; native credentials never enter the renderer.
const STORAGE_KEY = "provider-usage-v1";
const MAX_ENTRIES = 32;
const RETENTION_MS = 35 * 24 * 60 * 60_000;
const ownerSchema = z.tuple([
  browserSubscriptionProviderSchema,
  z.enum(["account", "cli"]),
  z.string().uuid().nullable(),
  z.string().max(2048),
]);
const savedSchema = z
  .object({ owner: z.string().max(2300), data: providerUsageSnapshotSchema })
  .strict();
type SavedUsage = z.infer<typeof savedSchema>;
const knownAccounts = new Map<
  BrowserSubscriptionProvider,
  ReadonlySet<string>
>();

function validTime(data: ProviderUsageSnapshot): boolean {
  const age = Date.now() - data.fetchedAt;
  return age >= 0 && age <= RETENTION_MS;
}
function ownerParts(owner: string) {
  try {
    return ownerSchema.parse(JSON.parse(owner));
  } catch {
    return undefined;
  }
}
function ownerForKey(key: string): string | undefined {
  try {
    const [provider, method, accountId, , identity] = JSON.parse(key);
    const owner = ownerSchema.parse([provider, method, accountId, identity]);
    // A CLI without confirmed identity cannot safely restore an earlier
    // device login. Saved Account profiles have their own durable UUID.
    if (method === "cli" && (!identity || identity === "[null,null]"))
      return undefined;
    return JSON.stringify(owner);
  } catch {
    return undefined;
  }
}
function matchesOwner(owner: string, data: ProviderUsageSnapshot): boolean {
  const parts = ownerParts(owner);
  return Boolean(
    parts &&
    parts[0] === data.provider &&
    parts[1] === data.method &&
    parts[2] === (data.accountId ?? null) &&
    // Earlier CLI snapshots never confirmed whose token supplied their quota.
    // Discard those ambiguous records when reading the existing storage key.
    (data.method !== "cli" || parts[3] === data.identity) &&
    (data.identity === undefined || parts[3] === data.identity),
  );
}
function loadSavedUsage(): Map<string, SavedUsage> {
  const raw = getSetting<unknown>(STORAGE_KEY, []);
  if (!Array.isArray(raw)) return new Map();
  const entries = raw.slice(-MAX_ENTRIES).flatMap((value) => {
    const result = savedSchema.safeParse(value);
    return result.success &&
      validTime(result.data.data) &&
      matchesOwner(result.data.owner, result.data.data)
      ? [result.data]
      : [];
  });
  return new Map(entries.map((entry) => [entry.owner, entry]));
}
const saved = loadSavedUsage();
function persist(): void {
  for (const [owner, entry] of saved)
    if (!validTime(entry.data)) saved.delete(owner);
  while (saved.size > MAX_ENTRIES) saved.delete(saved.keys().next().value!);
  setSetting(STORAGE_KEY, [...saved.values()]);
}

export function restoreProviderUsage(key: string) {
  const owner = ownerForKey(key);
  const entry = owner ? saved.get(owner) : undefined;
  return entry && validTime(entry.data)
    ? { data: entry.data, updatedAt: entry.data.fetchedAt }
    : undefined;
}
export function persistProviderUsage(
  key: string,
  data: ProviderUsageSnapshot,
): void {
  const allowed = knownAccounts.get(data.provider);
  if (data.accountId && allowed && !allowed.has(data.accountId))
    throw new Error("The account was disconnected. Refresh to view usage.");
  const owner = ownerForKey(key);
  if (!owner || !validTime(data) || !matchesOwner(owner, data)) return;
  if ((saved.get(owner)?.data.fetchedAt ?? 0) > data.fetchedAt) return;
  saved.delete(owner);
  saved.set(owner, { owner, data });
  persist();
}
export function pruneProviderUsageAccounts(
  provider: BrowserSubscriptionProvider,
  accountIds: readonly string[],
): void {
  const allowed = new Set(accountIds);
  knownAccounts.set(provider, allowed);
  let changed = false;
  for (const [owner, entry] of saved) {
    if (
      entry.data.provider === provider &&
      entry.data.method === "account" &&
      !allowed.has(entry.data.accountId!)
    ) {
      saved.delete(owner);
      changed = true;
    }
  }
  if (changed) persist();
}
