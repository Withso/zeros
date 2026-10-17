// ──────────────────────────────────────────────────────────
// Local orchestration — what a chat can see
// ──────────────────────────────────────────────────────────
//
// Visibility replaces permission prompts (user decision D5/D6). A chat sees:
//   - its family: every chat in the same "created by" tree;
//   - every chat tab in any workspace its family lives in or created;
//   - every chat and workspace shared by link with ANY member of its family
//     (shares flow down to children and up to parents automatically).
// Everything else is private to it: lists omit it and commands report it as
// not found. Visibility is recomputed from the database on every call.
// ──────────────────────────────────────────────────────────

import type { ChatRow } from "../db/chats";
import {
  familyCreatedWorkspaces,
  localFamilyMembers,
  localRootOf,
  localSharesForChats,
} from "../db/local-orchestration";
import type { LocalOwnerIndex } from "./owners";
import type { LocalWorkspaceOwner } from "./types";

export type LocalVisibleAs = "self" | "family" | "workspace" | "shared";

export interface LocalVisibility {
  callerChatId: string;
  rootChatId: string;
  family: ReadonlySet<string>;
  /** Workspaces whose chat tabs are all visible (family + shared workspaces). */
  workspaceIds: ReadonlySet<string>;
  familyWorkspaceIds: ReadonlySet<string>;
  sharedWorkspaceIds: ReadonlySet<string>;
  sharedChatIds: ReadonlySet<string>;
}

export function computeVisibility(
  callerChatId: string,
  index: LocalOwnerIndex,
  getChat: (id: string) => ChatRow | null,
): LocalVisibility {
  const rootChatId = localRootOf(callerChatId);
  const family = new Set(localFamilyMembers(callerChatId));
  const familyWorkspaceIds = new Set<string>();
  for (const chatId of family) {
    const chat = getChat(chatId);
    const owner = chat ? index.ownerOfFolder(chat.folder) : null;
    if (owner && owner !== "foreign") familyWorkspaceIds.add(owner.id);
  }
  for (const workspaceId of familyCreatedWorkspaces(rootChatId)) familyWorkspaceIds.add(workspaceId);
  const sharedWorkspaceIds = new Set<string>();
  const sharedChatIds = new Set<string>();
  for (const share of localSharesForChats([...family])) {
    if (share.kind === "workspace") sharedWorkspaceIds.add(share.targetId);
    else sharedChatIds.add(share.targetId);
  }
  return {
    callerChatId,
    rootChatId,
    family,
    workspaceIds: new Set([...familyWorkspaceIds, ...sharedWorkspaceIds]),
    familyWorkspaceIds,
    sharedWorkspaceIds,
    sharedChatIds,
  };
}

/** How the caller can see a chat, or null when it is private to the caller. */
export function chatVisibleAs(
  visibility: LocalVisibility,
  chatId: string,
  owner: LocalWorkspaceOwner | "foreign" | null,
): LocalVisibleAs | null {
  if (chatId === visibility.callerChatId) return "self";
  if (visibility.family.has(chatId)) return "family";
  if (owner && owner !== "foreign" && visibility.workspaceIds.has(owner.id)) {
    return visibility.familyWorkspaceIds.has(owner.id) ? "workspace" : "shared";
  }
  if (visibility.sharedChatIds.has(chatId)) return "shared";
  return null;
}

export function workspaceVisibleAs(
  visibility: LocalVisibility,
  workspaceId: string,
  callerWorkspaceId: string | null,
): "self" | "family" | "shared" | null {
  if (workspaceId === callerWorkspaceId) return "self";
  if (visibility.familyWorkspaceIds.has(workspaceId)) return "family";
  if (visibility.sharedWorkspaceIds.has(workspaceId)) return "shared";
  return null;
}
