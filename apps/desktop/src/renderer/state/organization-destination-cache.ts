import { accountPresentationGeneration, getAccountPresentationOwner } from "../platform/account-presentation-cache";
import { cloudWorkspaceKey, isCloudWorkspace, parseCloudScopedId, parseCloudWorkspaceKey } from "../platform/bridge/cloud-workspace-key";
import { readPreferenceCache, writePreferenceCache } from "../platform/personal-preferences";

const KEY = "zeros-organization-destinations:v1";
const MAX_ENTRIES = 128;
const MAX_BYTES = 512 * 1024;
const validString = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 4096;

export interface OrganizationDestination {
  folder: string;
  chatId: string | null;
  /** Local navigation is device-owned; cloud navigation belongs to an account/backend. */
  owner: string | null;
}

function validDestination(organizationId: string, value: unknown): value is OrganizationDestination {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as OrganizationDestination;
  if (!validString(row.folder) || row.chatId !== null && !validString(row.chatId)) return false;
  if (!isCloudWorkspace(row.folder)) return row.folder.startsWith("/") && row.owner === null && !row.chatId?.startsWith("cloud:");
  try {
    const target = parseCloudWorkspaceKey(row.folder);
    const chat = row.chatId ? parseCloudScopedId(row.chatId) : null;
    return validString(row.owner) && !!target && !target.relativePath && target.organizationId === organizationId &&
      (row.chatId === null || !!chat && cloudWorkspaceKey(chat) === cloudWorkspaceKey(target));
  } catch { return false; }
}

function read(): Map<string, OrganizationDestination> {
  try {
    const raw = readPreferenceCache(KEY);
    if (!raw || raw.length * 2 > MAX_BYTES) return new Map();
    const parsed = JSON.parse(raw);
    if (parsed?.version !== 1 || !Array.isArray(parsed.entries) || parsed.entries.length > MAX_ENTRIES) return new Map();
    return new Map(parsed.entries.filter((entry: unknown): entry is [string, OrganizationDestination] =>
      Array.isArray(entry) && entry.length === 2 && validString(entry[0]) && validDestination(entry[0], entry[1])));
  } catch { return new Map(); }
}

function write(entries: Map<string, OrganizationDestination>): void {
  let raw: string;
  do {
    if (entries.size > MAX_ENTRIES) entries.delete(entries.keys().next().value!);
    raw = JSON.stringify({ version: 1, entries: [...entries] });
    if (raw.length * 2 <= MAX_BYTES) break;
    entries.delete(entries.keys().next().value!);
  } while (entries.size);
  if (!writePreferenceCache(KEY, raw)) writePreferenceCache(KEY, null);
}

export function getOrganizationDestination(organizationId: string): OrganizationDestination | null {
  const row = read().get(organizationId);
  return row && (!isCloudWorkspace(row.folder) || row.owner === getAccountPresentationOwner()) ? row : null;
}

export function rememberOrganizationDestination(
  organizationId: string,
  folder: string,
  chatId: string | null,
  generation = accountPresentationGeneration(),
): void {
  if (generation !== accountPresentationGeneration() || !validString(organizationId)) return;
  const row = { folder, chatId, owner: isCloudWorkspace(folder) ? getAccountPresentationOwner() : null };
  if (!validDestination(organizationId, row)) return;
  const entries = read();
  const previous = entries.get(organizationId);
  if (previous?.folder === folder && previous.chatId === chatId && previous.owner === row.owner) return;
  entries.delete(organizationId);
  entries.set(organizationId, row);
  write(entries);
}

export function pruneOrganizationDestinations(
  removed: (destination: OrganizationDestination, organizationId: string) => boolean,
): void {
  const entries = read();
  let changed = false;
  for (const [organizationId, destination] of entries) if (removed(destination, organizationId)) {
    entries.delete(organizationId);
    changed = true;
  }
  if (changed) write(entries);
}
