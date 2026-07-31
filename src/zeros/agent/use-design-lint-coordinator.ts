// Turn-end design lint and one-shot deterministic correction loop.
//
// This renderer-wide observer mirrors the Git refresh coordinator's
// streaming→settled edge. It refreshes the shared aggregate snapshot so the
// canvas, inspector, and latest turn card agree, then auto-sends at most one
// correction for a stable error signature. A still-broken correction cannot
// recursively prompt forever; a clean lint clears the signature.

import { useEffect, useRef } from "react";
import { useShallow } from "zustand/react/shallow";

import { workspaceList, type Workspace } from "../../native/git";
import { finishedStreamingChatIds } from "../../shell/use-git-refresh-key";
import { refreshDesignWorkspaceSnapshot } from "../store/design-workspace-cache";
import { loadProjects } from "../store/projects-store";
import { useWorkspaceStore } from "../store/store";
import { peekWorkspacesFor } from "../store/use-projects";
import {
  findProjectForFolder,
  findWorkspaceForFolder,
} from "../store/workspace-resolution";
import { useAgentSessions } from "./sessions-hooks";
import { useSessionsStore } from "./sessions-store";
import {
  designLintCorrectionPrompt,
  designLintCorrectionSignature,
  designLintErrors,
} from "./design-lint-correction";

const MAX_CORRECTION_SIGNATURES = 64;

async function resolveDesignWorkspace(
  folder: string,
): Promise<Workspace | null> {
  const project = findProjectForFolder(folder, loadProjects());
  if (!project) return null;
  let workspace = findWorkspaceForFolder(
    folder,
    peekWorkspacesFor(project.repoSlug) ?? [],
  );
  if (!workspace) {
    const workspaces = await workspaceList({
      repoSlug: project.repoSlug,
      archived: false,
    });
    workspace = findWorkspaceForFolder(folder, workspaces);
  }
  return workspace?.kind === "design" ? workspace : null;
}

function rememberSignature(
  signatures: Map<string, string>,
  workspaceId: string,
  signature: string,
): void {
  signatures.delete(workspaceId);
  signatures.set(workspaceId, signature);
  while (signatures.size > MAX_CORRECTION_SIGNATURES) {
    const oldest = signatures.keys().next().value as string | undefined;
    if (!oldest) break;
    signatures.delete(oldest);
  }
}

export function useDesignLintCoordinator(): void {
  const sessions = useAgentSessions();
  const streamingChatIds = useSessionsStore(
    useShallow((state) =>
      Object.entries(state.sessions)
        .filter(([, session]) => session.status === "streaming")
        .map(([chatId]) => chatId)
        .sort(),
    ),
  );
  const previousStreamingRef = useRef<readonly string[] | null>(null);
  const correctionSignaturesRef = useRef(new Map<string, string>());
  const lintFlightsRef = useRef(new Set<string>());

  useEffect(() => {
    const previous = previousStreamingRef.current;
    previousStreamingRef.current = streamingChatIds;
    if (!previous) return;
    const finished = finishedStreamingChatIds(previous, streamingChatIds);
    for (const chatId of finished) {
      const chat = useWorkspaceStore
        .getState()
        .chats.find((candidate) => candidate.id === chatId);
      if (!chat || chat.mode !== "design") continue;

      void (async () => {
        const workspace = await resolveDesignWorkspace(chat.folder).catch(
          () => null,
        );
        if (!workspace || lintFlightsRef.current.has(workspace.id)) return;
        lintFlightsRef.current.add(workspace.id);
        try {
          const snapshot = await refreshDesignWorkspaceSnapshot(workspace.id);
          const signature = designLintCorrectionSignature(snapshot.lint);
          if (!signature) {
            correctionSignaturesRef.current.delete(workspace.id);
            return;
          }
          if (correctionSignaturesRef.current.get(workspace.id) === signature) {
            return;
          }

          const liveSession = useSessionsStore.getState().sessions[chatId];
          if (
            liveSession?.status !== "ready" ||
            liveSession.pendingPermission ||
            liveSession.pendingQuestions.length > 0
          ) {
            return;
          }

          rememberSignature(
            correctionSignaturesRef.current,
            workspace.id,
            signature,
          );
          const count = designLintErrors(snapshot.lint).length;
          try {
            await sessions.sendPrompt(
              chatId,
              designLintCorrectionPrompt(snapshot.lint),
              `Fix ${count} design lint ${count === 1 ? "error" : "errors"}`,
              undefined,
              undefined,
              undefined,
              "design-lint",
            );
          } catch {
            if (
              correctionSignaturesRef.current.get(workspace.id) === signature
            ) {
              correctionSignaturesRef.current.delete(workspace.id);
            }
          }
        } finally {
          lintFlightsRef.current.delete(workspace.id);
        }
      })().catch(() => {
        // Design refreshes are advisory to the completed turn. A bridge or
        // filesystem failure must not surface as an unhandled renderer error.
      });
    }
  }, [sessions, streamingChatIds]);
}
