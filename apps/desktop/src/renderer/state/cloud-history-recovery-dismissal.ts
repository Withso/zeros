import { z } from "zod";
import { cloudWorkspaceKey, parseCloudWorkspaceKey } from "../platform/bridge/cloud-workspace-key";
import { getSetting, setSetting } from "../platform/settings";

const KEY = "cloud-history-recovery-dismissed-v1", LIMIT = 128;
const receiptSchema = z.string().uuid();
const listeners = new Set<() => void>();
export const subscribeCloudHistoryRecoveryDismissals = (listener: () => void) => {
  listeners.add(listener); return () => { listeners.delete(listener); };
};
function valid(folder: unknown, receipt: unknown): folder is string {
  if (typeof folder !== "string" || folder.length > 256 || !receiptSchema.safeParse(receipt).success) return false;
  try { const target = parseCloudWorkspaceKey(folder); return !!target && cloudWorkspaceKey(target) === folder; }
  catch { return false; }
}
function read(): [string, string][] {
  const raw = getSetting<unknown>(KEY, []);
  if (!Array.isArray(raw)) return [];
  const unique = new Map<string, [string, string]>();
  for (const row of raw.slice(-LIMIT))
    if (Array.isArray(row) && row.length === 2 && valid(row[0], row[1])) unique.set(JSON.stringify(row), [row[0], row[1] as string]);
  return [...unique.values()];
}
export function cloudHistoryRecoveryDismissed(folder: string, receipt: string): boolean {
  return valid(folder, receipt) && read().some(row => row[0] === folder && row[1] === receipt);
}
export function dismissCloudHistoryRecovery(folder: string, receipt: string): void {
  if (!valid(folder, receipt)) return;
  const rows = read().filter(row => row[0] !== folder || row[1] !== receipt);
  rows.push([folder, receipt]); setSetting(KEY, rows.slice(-LIMIT));
  for (const listener of listeners) listener();
}
export function forgetCloudHistoryRecoveryDismissals(folders: readonly string[]): void {
  if (!folders.length) return;
  const removed = new Set(folders), rows = read(), next = rows.filter(row => !removed.has(row[0]));
  if (next.length === rows.length) return;
  setSetting(KEY, next); for (const listener of listeners) listener();
}
