// ──────────────────────────────────────────────────────────
// No-folder placeholder
// ──────────────────────────────────────────────────────────
//
// Rendered in place of the chat body when a chat has no project folder
// bound (chat.folder empty AND no active workspace scope to fall back
// on). Without this guard the agent spawn reached the gateway with an
// empty cwd and threw "Agent cannot spawn: chat has no project folder
// bound" — which surfaced as a red "Agent error" pill and a dead
// composer for EVERY agent (cursor, codex, …). This is the
// keystone backstop: it catches a folderless chat from any entry point
// (a brand-new user who typed before picking a folder, a stale persisted
// record whose folder never resolved, an all-workspaces-closed state)
// and turns the crash into one explicit action — pick a folder, which
// binds it to the chat so the session can spawn. The chat's history is
// untouched.
//
// Styling mirrors AgentRemovedPanel for a consistent dead-end card.
// ──────────────────────────────────────────────────────────

import React, { useState } from "react";
import { FolderOpen } from "lucide-react";

import { Button } from "../shared/ui";
import { useWorkspaceDispatch } from "../state/store";
import { pickAndRegisterFolder } from "./bind-folder";
import { ZerosSpinner } from "@/renderer/shared/ui/loading";

export function NoFolderPanel({ chatId }: { chatId: string }) {
  return <NativeNoFolderPanel chatId={chatId} />;
}

function NativeNoFolderPanel({ chatId }: { chatId: string }) {
  const dispatch = useWorkspaceDispatch();
  const [busy, setBusy] = useState(false);

  const handlePick = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const folder = await pickAndRegisterFolder();
      if (folder) {
        // Binding the folder flips cwd non-empty → ChatView
        // re-renders into the live ChatBody and the session spawns.
        dispatch({
          type: "UPDATE_CHAT_SETTINGS",
          id: chatId,
          updates: { folder },
        });
      }
    } catch (err) {
      console.warn("[Zeros] bind folder failed:", err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="bg-bg1 flex h-full w-full items-center justify-center p-6">
      <div className="flex w-full max-w-md flex-col items-center gap-5 text-center">
        <div className="border-border1 bg-bg2 flex size-12 items-center justify-center rounded-sm border">
          <FolderOpen className="text-muted-fg size-6" aria-hidden="true" />
        </div>
        <div className="space-y-1.5">
          <h3 className="text-fg1 text-sm font-medium">No folder selected</h3>
          <p className="text-fg2 text-xs leading-relaxed">
            This chat isn’t bound to a project folder yet, so the agent has
            nowhere to run. Pick a folder to start the session — your chat
            history is kept.
          </p>
        </div>
        <Button
          variant="secondary"
          size="sm"
          onClick={handlePick}
          disabled={busy}
        >
          {busy ? (
            <ZerosSpinner size={16} />
          ) : (
            <FolderOpen size={14} aria-hidden="true" />
          )}
          {busy ? "Opening…" : "Pick a folder"}
        </Button>
      </div>
    </div>
  );
}
