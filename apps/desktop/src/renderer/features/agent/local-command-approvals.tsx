import { useEffect, useMemo, useSyncExternalStore } from "react";
import { cloudScopedId } from "../../platform/bridge/cloud-workspace-key";
import {
  decideLocalCommand, isDecidingLocalCommand, notifyLocalCommand, startLocalCommandApprovals, useLocalCommandApprovals, useOpenedLocalCommand,
  type LocalCommandApprovalView, type LocalCommandDecision,
} from "../../platform/local-commands";
import { cloudWorkspaceDocumentById } from "../../state/cloud-workspace-catalog";
import { toast } from "../../shared/ui/primitives/elements";
import { LocalCommandApprovalCard } from "./local-command-card";

/** The renderer chat id of an approval's chat, once its workspace is in the catalog. */
export function approvalChatId(approval: LocalCommandApprovalView, lookup = cloudWorkspaceDocumentById): string | null {
  const document = lookup(approval.workspaceId);
  return document ? cloudScopedId({ organizationId: document.organizationId, workspaceId: approval.workspaceId }, approval.chatId) : null;
}

// One owner per approval: the visible chat, else the global host.
const visibleChats = new Map<string, number>();
const listeners = new Set<() => void>();
let version = 0;
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const snapshot = () => version;
function claimChat(chatId: string): () => void {
  visibleChats.set(chatId, (visibleChats.get(chatId) ?? 0) + 1); version++; for (const listener of listeners) listener();
  return () => {
    const count = (visibleChats.get(chatId) ?? 1) - 1;
    if (count > 0) visibleChats.set(chatId, count); else visibleChats.delete(chatId);
    version++; for (const listener of listeners) listener();
  };
}
function useVisibleChats(): ReadonlyMap<string, number> { useSyncExternalStore(subscribe, snapshot, snapshot); return visibleChats; }

const decide = (approval: LocalCommandApprovalView, decision: LocalCommandDecision) =>
  void decideLocalCommand(approval.requestId, decision).catch(() => toast.error("Couldn't send your decision to this Mac's request."));

function card(approval: LocalCommandApprovalView) {
  return <LocalCommandApprovalCard key={approval.requestId} deciding={isDecidingLocalCommand(approval.requestId)} onDecide={decision => decide(approval, decision)}
    request={{ requestId: approval.requestId, macName: approval.macName, workspaceName: approval.workspaceTitle ? `${approval.workspaceName} · ${approval.workspaceTitle}` : approval.workspaceName,
      chatTitle: approval.chatTitle || "Untitled chat", command: approval.command, timeoutMs: approval.timeoutMs,
      ...(approval.cwd ? { cwd: approval.cwd } : {}), ...(approval.description ? { description: approval.description } : {}), ...(approval.reason ? { reason: approval.reason } : {}),
      ...(approval.extendedTimeoutReason ? { extendedTimeoutReason: approval.extendedTimeoutReason } : {}), ...(approval.explicitFrom ? { explicitFrom: approval.explicitFrom } : {}) }} />;
}

/** In a chat's dock: this chat's approvals, while the chat is the visible one. */
export function LocalCommandChatApprovals({ chatId, active }: { chatId: string | undefined; active: boolean }) {
  const approvals = useLocalCommandApprovals();
  useEffect(() => (active && chatId ? claimChat(chatId) : undefined), [active, chatId]);
  const mine = useMemo(() => active && chatId ? approvals.filter(approval => approvalChatId(approval) === chatId) : [], [approvals, active, chatId]);
  return mine.length ? <>{mine.map(card)}</> : null;
}

/** App-wide: approvals whose chat is not on screen, so a request never waits unseen.
 * Their workspace is not open here, so main is also asked for a notification. */
export function LocalCommandApprovalHost() {
  useEffect(() => { startLocalCommandApprovals(); }, []);
  const approvals = useLocalCommandApprovals(), visible = useVisibleChats(), opened = useOpenedLocalCommand();
  const orphans = approvals.filter(approval => { const chat = approvalChatId(approval); return !chat || !visible.has(chat); });
  const orphanIds = orphans.map(approval => approval.requestId).join(",");
  useEffect(() => { for (const id of orphanIds ? orphanIds.split(",") : []) notifyLocalCommand(id); }, [orphanIds]);
  if (!orphans.length) return null;
  const ordered = opened ? [...orphans].sort((a, b) => Number(b.requestId === opened) - Number(a.requestId === opened)) : orphans;
  return <div aria-label="Local command requests" role="region" className="z-toast fixed right-4 bottom-4 flex w-[420px] flex-col gap-2">{ordered.map(card)}</div>;
}
