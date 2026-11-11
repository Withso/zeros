// PURPOSE: The frame info panel at the foot of the Style panel, above Layers:
// a selected frame's changes made by hand and Tidy. Mounted only while a
// frame (not a layer in it) is selected; it renders nothing until that frame
// has changes, a Tidy running or a Tidy just done. Nothing else in Design
// shows Tidy: no toast, no canvas mark.

import { useEffect } from "react";
import { Sparkles } from "lucide-react";

import { Button } from "../../shared/ui/primitives";
import { openFilePill, warmFilePill } from "../../shell/workbench/file-pill-navigation";
import { useWorkspaceDispatch } from "../../state/workspace-store";
import { designTidyBrief, type DesignAgentBrief } from "./design-agent-brief";
import type { DesignAskAgentHooks } from "./design-agent-sync";
import {
  designFrameChangesKey,
  designFrameChangesSummary,
  dismissDesignTidy,
  finishDesignTidy,
  readDesignFrameChanges,
  readDesignTidyOutcome,
  startDesignTidy,
  useDesignFrameChangesStore,
  useDesignTidyStore,
} from "./state/design-frame-changes";
import { useDesignRuntimeStore } from "./state/design-runtime-store";

export function DesignFrameChangesPanel({
  workspaceId,
  folder,
  frame,
  directory,
  active,
  onAskAgent,
}: {
  workspaceId: string;
  folder: string;
  /** The selected frame's file. */
  frame: string;
  /** The Design directory, for the frame's path in Changes. */
  directory: string | null;
  /** The Design surface is shown; nothing is read while it is hidden. */
  active: boolean;
  onAskAgent?: (brief: DesignAgentBrief, hooks?: DesignAskAgentHooks) => void;
}) {
  const key = designFrameChangesKey(workspaceId, frame);
  // The generation the frame's runtime shows: the one its changes are read for.
  const sourceVersion = useDesignRuntimeStore((state) => state.byWorkspace[workspaceId]?.frames[frame]?.sourceVersion ?? null);
  const entry = useDesignFrameChangesStore((state) => state.byKey[key]);
  const tidy = useDesignTidyStore((state) => state.byKey[key]);
  const dispatch = useWorkspaceDispatch();

  useEffect(() => {
    if (!active || !sourceVersion) return;
    const gone = new AbortController();
    readDesignFrameChanges(workspaceId, frame, sourceVersion, gone.signal);
    return () => gone.abort();
  }, [active, frame, sourceVersion, workspaceId]);

  // The brief's turn ended: once the changes of the generation it left are
  // read, say what moved. A later change dismisses it.
  const latest = entry?.sourceVersion === sourceVersion ? entry : undefined;
  useEffect(() => {
    if (tidy?.phase !== "ended" || !latest || !sourceVersion) return;
    let current = true;
    void readDesignTidyOutcome(workspaceId, frame, sourceVersion, tidy.before, latest.changes).then((outcome) => {
      if (current && outcome) finishDesignTidy(workspaceId, frame, outcome, sourceVersion);
    });
    return () => {
      current = false;
    };
  }, [frame, latest, sourceVersion, tidy?.before, tidy?.phase, workspaceId]);
  useEffect(() => {
    if (tidy?.phase === "done" && sourceVersion && tidy.doneVersion !== sourceVersion) dismissDesignTidy(workspaceId, frame);
  }, [frame, sourceVersion, tidy?.doneVersion, tidy?.phase, workspaceId]);
  // Selecting something else dismisses an outcome; a running Tidy carries on.
  useEffect(
    () => () => {
      const phase = useDesignTidyStore.getState().byKey[key]?.phase;
      if (phase === "ended" || phase === "done") dismissDesignTidy(workspaceId, frame);
    },
    [frame, key, workspaceId],
  );

  if (tidy && tidy.phase !== "done") {
    const count = tidy.before.length;
    return (
      <DesignFrameInfo
        state="running"
        title={`Tidying ${count} ${count === 1 ? "change" : "changes"}`}
        body="The agent is moving them into tokens, classes or the component."
        action={
          <Button
            type="button"
            variant="secondary"
            size="compact"
            disabled={!tidy.chatId}
            onClick={() => {
              if (tidy.chatId) dispatch({ type: "SET_ACTIVE_CHAT", id: tidy.chatId });
            }}
          >
            View chat
          </Button>
        }
      />
    );
  }
  if (tidy?.phase === "done" && tidy.outcome) {
    const path = directory ? `${directory}/${frame}` : null;
    const warm = () => {
      if (path) warmFilePill(folder, path, "changes");
    };
    return (
      <DesignFrameInfo
        state="done"
        title="Tidied"
        body={tidy.outcome}
        action={
          <Button
            type="button"
            variant="secondary"
            size="compact"
            disabled={!path}
            onPointerEnter={warm}
            onFocus={warm}
            onClick={() => {
              if (path) openFilePill(folder, path, "changes");
            }}
          >
            Review
          </Button>
        }
      />
    );
  }
  const summary = entry ? designFrameChangesSummary(entry.changes, entry.truncated) : null;
  if (!entry || !summary) return null;
  return (
    <DesignFrameInfo
      state="waiting"
      title={summary.title}
      body={summary.body}
      action={
        <Button
          type="button"
          variant="secondary"
          size="compact"
          disabled={!onAskAgent || !active}
          onClick={() => {
            if (!onAskAgent) return;
            const before = entry.changes;
            startDesignTidy({
              workspaceId,
              frame,
              before,
              ask: (hooks) => onAskAgent(designTidyBrief({ directory: directory ?? "", frame, changes: before }), hooks),
            });
          }}
        >
          <Sparkles aria-hidden="true" />
          Tidy
        </Button>
      }
    />
  );
}

function DesignFrameInfo({
  state,
  title,
  body,
  action,
}: {
  state: "waiting" | "running" | "done";
  title: string;
  body: string;
  action: React.ReactNode;
}) {
  return (
    <section
      aria-label="Frame changes"
      data-design-frame-info={state}
      className="border-border1 flex shrink-0 flex-col gap-1.5 border-t pt-2.5 pr-2 pb-3 pl-3"
    >
      <div className="text-fg1 flex min-h-6 items-center gap-2 text-xs leading-4.5 font-medium">
        {state === "waiting" ? <span aria-hidden="true" className="bg-blue-primary size-1.25 shrink-0 rounded-full" /> : null}
        <span className="min-w-0 truncate">{title}</span>
        <span className="ml-auto shrink-0">{action}</span>
      </div>
      <p className="text-fg3 pr-1 text-3xxs leading-4">{body}</p>
    </section>
  );
}
