// ──────────────────────────────────────────────────────────
// spawn-default-chat — auto-create a chat tab for a new workspace
// ──────────────────────────────────────────────────────────
//
// The user's contract (2026-07-06 hardening): when a workspace is
// created or comes into view with no live chat, it ALWAYS gets a fresh
// "Untitled" chat tab — there is no "no chat selected" state anymore
// (column2-chat-view renders a dead pane for a null active chat since
// the EmptyComposer landing was deleted 2026-06-18).
//
// This sits between the workspace-creation handlers in Column 1 and
// the workspace store so every entry point — "+" plus, Create-from
// picker, Quick Start, Open GitHub project, Add local project, plain
// workspace-row click, the tab strip's selection keeper — shares the
// same dispatch flow.
//
// Agent resolution is best-effort, chat creation is not: if no agent
// can be resolved right now (registry probe failed mid engine restart,
// nothing runnable), the chat is created with a null agentId and
// <AutoBindAgent> in column2-chat-view binds the resolved default on
// mount — the product rule "every chat always has an agent" is enforced
// there. The common path is fully synchronous via the persisted agents
// cache, so there's no multi-second black-pane gap while the registry
// round-trips.
// ──────────────────────────────────────────────────────────

import type { BridgeRegistryAgent } from "../bridge/messages";
import type { SessionsCtx } from "../agent/sessions-context";
import { getAgentsSnapshot } from "../agent/agents-cache";
import { pickDefaultAgent } from "../panels/default-agent";
import { newChatBornDefaults } from "../agent/new-chat-defaults";
import { newChatId } from "./chat-id";
import type { ChatThread } from "./store";
import { useWorkspaceDispatch, useWorkspaceStore } from "./workspace-store";

type Dispatch = ReturnType<typeof useWorkspaceDispatch>;

/** Build the ChatThread a fresh "Untitled" chat for `agent` at `folder` is
 *  born as — newChatBornDefaults (default model + effort + posture + fast)
 *  stamped into the standard tab shape. A temporarily unavailable registry
 *  is represented by a null agent; AutoBindAgent fills the binding when the
 *  tab mounts. Shared by every user-facing spawn path so they cannot drift. */
export function bornChatThread(
  agent: BridgeRegistryAgent | null,
  folder: string,
): ChatThread {
  const born = newChatBornDefaults(agent?.id ?? null);
  return {
    id: newChatId(),
    folder,
    agentId: agent?.id ?? null,
    agentName: agent?.name ?? null,
    model: born.model,
    effort: born.effort,
    permissionMode: born.permissionMode,
    ...(born.fast ? { fast: true } : {}),
    title: "Untitled",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

function cachedDefaultAgent(): BridgeRegistryAgent | null {
  const cached = getAgentsSnapshot();
  return cached ? pickDefaultAgent(cached) : null;
}

/** Open an additional chat tab in an already-active workspace. Unlike
 *  spawnDefaultChatForWorkspace, this intentionally does not de-duplicate
 *  against an existing live chat: every invocation is a user request for a
 *  new tab (plus → Chat or ⌘T). */
export async function spawnNewChatTab(args: {
  folder: string;
  sessions: SessionsCtx;
  dispatch: Dispatch;
}): Promise<ChatThread> {
  const { folder, dispatch } = args;
  // Never put tab creation behind a native registry read. A cold cache creates
  // an agentless tab synchronously; AutoBindAgent fills it on first render.
  const chat = bornChatThread(cachedDefaultAgent(), folder);
  dispatch({ type: "ADD_CHAT", chat });
  return chat;
}

/** Publish a prepared workspace destination and its first Untitled chat in one
 * store transition. The path is an exact engine reservation, but is not a
 * usable cwd yet; `validationPending` keeps normal selection repair from
 * treating it as a confirmed worktree while the provisional composer renders. */
export function spawnPreparedDefaultChat(args: {
  folder: string;
  repoRoot: string;
  dispatch: Dispatch;
}): ChatThread {
  const chat = bornChatThread(cachedDefaultAgent(), args.folder);
  args.dispatch({
    type: "ADD_CHAT",
    chat,
    openWorkspace: {
      repoRoot: args.repoRoot,
      validationPending: true,
    },
  });
  return chat;
}

/** In-flight guard: tracks folders that are currently mid-spawn so two
 *  concurrent callers (e.g. the "+" handler's workspace_create followed
 *  by the user clicking the freshly-created workspace row before React
 *  has flushed the ADD_CHAT dispatch) don't both spawn chats for the
 *  same path. Cleared in the `finally` block once the dispatch lands. */
const inFlightFolders = new Set<string>();

/** A live (non-archived) chat already at this folder, read FRESH from the
 *  store — not from a caller's possibly-stale `chats` snapshot. This is the
 *  dedupe that keeps a slow registry await (5–10 s during an engine respawn)
 *  from stacking a second "Untitled" tab onto a workspace that gained a chat
 *  meanwhile (the "row of duplicate Untitled tabs" bug). */
function liveChatAtFolder(folder: string): ChatThread | undefined {
  return useWorkspaceStore
    .getState()
    .chats.find((c) => !c.archived && c.folder === folder);
}

/** Resolve the default agent + dispatch ADD_CHAT for a freshly created
 *  or selected workspace. Returns true when a chat was spawned, false
 *  when an existing chat was activated instead (never "no chat").
 *  Existing-chat checks read the LIVE store, never a caller snapshot —
 *  so there's no `chats` argument to go stale. */
export async function spawnDefaultChatForWorkspace(args: {
  folder: string;
  sessions: SessionsCtx;
  dispatch: Dispatch;
}): Promise<boolean> {
  const { folder, dispatch } = args;
  // Coalesce concurrent calls for the same folder. The second caller
  // just activates the in-flight scope so the user still sees the
  // workspace switch immediately; the first caller's dispatch will
  // promote that scope into a real chat tab.
  if (inFlightFolders.has(folder)) {
    dispatch({ type: "SET_NEW_AGENT_FOLDER", folder });
    return false;
  }
  // Belt-and-suspenders: if a chat already exists for this folder, skip
  // the spawn and activate it. Reads the live store (not the caller's
  // `chats` snapshot) so a just-added chat can't be missed.
  const existing = liveChatAtFolder(folder);
  if (existing) {
    dispatch({ type: "SET_ACTIVE_CHAT", id: existing.id });
    return false;
  }
  inFlightFolders.add(folder);
  try {
    // A native registry read is server state and must never sit on the click
    // path. Cold cache is represented by a null binding; AutoBindAgent resolves
    // it after the Untitled tab is already visible.
    const agent = cachedDefaultAgent();
    // Born with the user's unified new-chat defaults (Settings → Models):
    // the family favorite model (null = the agent's own catalog default),
    // the default reasoning effort clamped to that model's ladder, and the
    // plan/fast posture. Shared with the "+" → Chat and ⌘T paths so they
    // can never drift. With no agent resolved, generic defaults apply and
    // AutoBindAgent fills the binding on first render.
    const chat = bornChatThread(agent, folder);
    dispatch({ type: "ADD_CHAT", chat });
    return true;
  } finally {
    inFlightFolders.delete(folder);
  }
}
