import { useSyncExternalStore } from "react";
import { z } from "zod";
import { LocalCommandConnectReplySchema, LocalCommandDisconnectReplySchema, LocalCommandMacsReplySchema, LocalCommandOrganizationSettingSchema,
  type LocalCommandMac } from "@zeros/protocol/local-commands";
import { LOCAL_COMMAND_APPROVALS_EVENT, LOCAL_COMMAND_OPEN_EVENT, type LocalCommandApprovalView, type LocalCommandDecision } from "../../../shared/local-commands";
import { cloudAccountRequest } from "./cloud-workspaces";
import { isElectron, nativeInvoke, nativeListen } from "./runtime";

export type { LocalCommandApprovalView, LocalCommandDecision };

/** This Mac's device headers for a prompt send, or none (not registered yet,
 * or not the Mac app). Never guessed: all three or nothing. */
type LocalCommandDeviceInfo = { deviceId: string; headers: Record<string, string> } | null;
export async function localCommandDevice(): Promise<LocalCommandDeviceInfo> {
  if (!isElectron()) return null;
  try { return await nativeInvoke<LocalCommandDeviceInfo>("local_commands_device"); }
  catch { return null; }
}

// ── Approvals raised by main for this Mac ───────────────────────────────
let approvals: readonly LocalCommandApprovalView[] = [];
let opened: string | null = null;
const deciding = new Set<string>();
const listeners = new Set<() => void>();
const changed = () => { for (const listener of listeners) listener(); };
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
let started: Promise<() => void> | undefined;

/** Main is the source of truth; this mirrors its list and the request a notification opened. */
export function startLocalCommandApprovals(): void {
  if (started || !isElectron()) return;
  const accept = (next: readonly LocalCommandApprovalView[]) => {
    approvals = next;
    for (const id of [...deciding]) if (!next.some(approval => approval.requestId === id)) deciding.delete(id);
    if (opened && !next.some(approval => approval.requestId === opened)) opened = null;
    changed();
  };
  started = Promise.all([
    nativeListen<readonly LocalCommandApprovalView[]>(LOCAL_COMMAND_APPROVALS_EVENT, accept),
    nativeListen<{ requestId: string }>(LOCAL_COMMAND_OPEN_EVENT, ({ requestId }) => { opened = requestId; changed(); }),
  ]).then(([stopApprovals, stopOpen]) => { void nativeInvoke<LocalCommandApprovalView[]>("local_commands_approvals").then(accept, () => {}); return () => { stopApprovals(); stopOpen(); }; });
}
export function resetLocalCommandApprovalsForTests(next: readonly LocalCommandApprovalView[] = []): void { approvals = next; opened = null; deciding.clear(); started = undefined; changed(); }
export function acceptLocalCommandApprovalsForTests(next: readonly LocalCommandApprovalView[]): void { approvals = next; changed(); }

const approvalsSnapshot = () => approvals;
export function useLocalCommandApprovals(): readonly LocalCommandApprovalView[] { return useSyncExternalStore(subscribe, approvalsSnapshot, approvalsSnapshot); }
const openedSnapshot = () => opened;
export function useOpenedLocalCommand(): string | null { return useSyncExternalStore(subscribe, openedSnapshot, openedSnapshot); }
export function isDecidingLocalCommand(requestId: string): boolean { return deciding.has(requestId); }

/** Relays the person's choice; main accepts it once, for a request it raised. */
export async function decideLocalCommand(requestId: string, decision: LocalCommandDecision): Promise<void> {
  if (deciding.has(requestId)) return;
  deciding.add(requestId); changed();
  try { await nativeInvoke("local_commands_decide", { requestId, decision }); }
  catch (error) { deciding.delete(requestId); changed(); throw error; }
}
/** Asks main for a macOS notification when the request's workspace is not open here. */
export function notifyLocalCommand(requestId: string): void { void nativeInvoke("local_commands_notify", { requestId }).catch(() => {}); }

// ── Always allow (device-local, main-owned) ─────────────────────────────
export const getAlwaysAllowLocalCommands = () => nativeInvoke<boolean>("local_commands_always_get");
export const setAlwaysAllowLocalCommands = (enabled: boolean) => nativeInvoke<boolean>("local_commands_always_set", { enabled });

// ── Connected Macs (no VM wake) ─────────────────────────────────────────
export async function listWorkspaceMacs(workspaceId: string): Promise<readonly LocalCommandMac[]> {
  const { macs } = await cloudAccountRequest(`/v1/cloud-v2/workspaces/${z.string().uuid().parse(workspaceId)}/macs`, LocalCommandMacsReplySchema);
  return macs;
}
/** Connect is issued by this Mac for itself (main adds the device headers). */
export async function connectThisMac(workspaceId: string) { return LocalCommandConnectReplySchema.parse(await nativeInvoke("local_commands_connect", { workspaceId })); }
export async function disconnectMac(workspaceId: string, deviceId: string) {
  return LocalCommandDisconnectReplySchema.parse(await nativeInvoke("local_commands_disconnect", { workspaceId, deviceId }));
}

// ── Organization switch ─────────────────────────────────────────────────
const settingPath = (organizationId: string) => `/v1/cloud-v2/organizations/${encodeURIComponent(z.string().uuid().parse(organizationId))}/local-commands`;
export async function readLocalCommandsEnabled(organizationId: string): Promise<boolean> {
  return (await cloudAccountRequest(settingPath(organizationId), LocalCommandOrganizationSettingSchema)).localCommandsEnabled;
}
export async function writeLocalCommandsEnabled(organizationId: string, enabled: boolean): Promise<boolean> {
  return (await cloudAccountRequest(settingPath(organizationId), LocalCommandOrganizationSettingSchema,
    { body: { localCommandsEnabled: enabled }, idempotencyKey: crypto.randomUUID(), method: "PUT" })).localCommandsEnabled;
}
