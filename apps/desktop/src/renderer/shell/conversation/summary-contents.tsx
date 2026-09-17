import React, { useCallback, useEffect, useMemo } from "react";
import {
  ArrowUpRight,
  Book,
  FileText,
  Image,
  Plus,
  Square,
} from "lucide-react";
import { useActiveWorkspace } from "../../state/use-active-workspace";
import { isLocalMainWorkspace } from "../../state/local-main-workspace";
import {
  useWorkspaceStore,
  workbenchScopeForFolder,
} from "../../state/workspace-store";
import { isNativeRuntime } from "../../platform/runtime";
import { subscribeContextGraphChanged } from "../../platform/context-graph";
import { Button, Tooltip } from "../../shared/ui/primitives";
import { DynamicIcon } from "../../shared/ui/icon-registry";
import { RunWave } from "../../shared/ui/loading";
import { cn } from "../../shared/ui/cn";
import { useRunControl } from "../terminal/use-run-control";
import { useRunStatuses } from "../terminal/use-run-status";
import { useRunPreviewUrls } from "../terminal/use-run-preview-urls";
import { useOpenBrowserInWorkbench } from "../workbench/use-open-browser";
import { useWorkspaceChangeLines } from "../use-workspace-change-lines";
import { useGitRefreshKey } from "../use-git-refresh-key";
import { warmWorkspaceFiles } from "../workspace-files-cache";
import { warmIgnoredRoots } from "../workbench/tabs/ignored-entries-cache";
import { parseRemote } from "../pr/github-url";
import { resolveReviewProvider } from "../pr/review-provider";
import { prefetchReviewLiveData } from "../workbench/tabs/review-data";
import {
  addWorkbenchTerminal,
  openWorkbenchTerminal,
} from "../workbench/open-terminal";
import {
  createBrowserTab,
  defaultScopeFor,
  TAB_TYPE_META,
  type WorkbenchTabType,
} from "../workbench/tab-model";
import { useOpenScriptsSettings } from "../workbench/tabs/setup-tab";
import {
  contextGraphKey,
  loadContextGraph,
  loadContextGraphForRefresh,
  useContextGraphSnapshot,
} from "../workbench/tabs/context-graph-data";
import { recentSummaryContext, summaryDestinationTab } from "./summary-model";

const DESTINATIONS = [
  "changes",
  "review",
  "browser",
  "terminal",
  "files",
] as const;
const ROW =
  "text-fg2 h-8 w-full min-w-0 justify-start gap-2 rounded-lg px-1.5 text-left font-normal hover:text-fg1";
const SECTION_LABEL = "text-fg3 text-3xxs mb-1 px-1.5 font-[450]";

export function SummaryContents({
  folder,
  active,
  onNavigate,
}: {
  folder: string;
  active: boolean;
  onNavigate: () => void;
}) {
  const { workspace, project } = useActiveWorkspace();
  const { actions, actionsReady, actionsError, startRun, stopRun, runIdFor } =
    useRunControl(folder, folder);
  const { statuses } = useRunStatuses(workspace, folder, actions, active);
  const previewUrls = useRunPreviewUrls(
    workspace?.id ?? null,
    folder,
    actions,
    statuses,
    active,
  );
  const openBrowser = useOpenBrowserInWorkbench(onNavigate);
  const changeLines = useWorkspaceChangeLines(workspace, active);
  const hasChanges = changeLines.additions > 0 || changeLines.deletions > 0;
  const openRunSettings = useOpenScriptsSettings("run-actions");
  const workspaceId = workspace
    ? isLocalMainWorkspace(workspace)
      ? workspace.repoRoot
      : workspace.id
    : null;
  const refreshKey = useGitRefreshKey(folder, workspaceId, active);
  const snapshot = useContextGraphSnapshot(folder);
  const recent = useMemo(
    () => recentSummaryContext(snapshot.data?.items ?? []),
    [snapshot.data],
  );

  useEffect(() => {
    if (!active) return;
    void loadContextGraphForRefresh(folder, refreshKey).catch(() => {});
  }, [active, folder, refreshKey]);

  useEffect(() => {
    if (!active) return;
    return subscribeContextGraphChanged((changedCwd) => {
      if (contextGraphKey(changedCwd) !== contextGraphKey(folder)) return;
      void loadContextGraph(folder).catch(() => {});
    });
  }, [active, folder]);

  const warm = useCallback(
    (type: WorkbenchTabType) => {
      if (type === "context") {
        void loadContextGraph(folder).catch(() => {});
      } else if (type === "files" || type === "changes") {
        warmWorkspaceFiles(folder);
        warmIgnoredRoots(folder);
      } else if (type === "review" && workspace?.prNumber) {
        const provider = resolveReviewProvider(
          parseRemote(project?.originUrl ?? "")?.host ?? "github.com",
        );
        if (provider)
          void prefetchReviewLiveData(
            provider,
            workspace.id,
            workspace.prNumber,
          ).catch(() => {});
      }
    },
    [folder, workspace, project?.originUrl],
  );

  const navigate = (type: WorkbenchTabType) => {
    const store = useWorkspaceStore.getState();
    const scope = workbenchScopeForFolder(folder);
    const current = store.workbenchByScope[scope] ?? defaultScopeFor(scope);
    const tab = summaryDestinationTab(current.tabs, current.activeId, type);
    if (type === "terminal") {
      if (tab?.terminalId)
        openWorkbenchTerminal(
          folder,
          { terminalId: tab.terminalId, title: tab.title },
          scope,
        );
      else addWorkbenchTerminal(folder, "tab", scope);
    } else if (tab) {
      store.dispatch({ type: "ACTIVATE_WORKBENCH_TAB", id: tab.id, scope });
    } else if (type === "browser") {
      store.dispatch({
        type: "ADD_WORKBENCH_TAB",
        tab: createBrowserTab(),
        scope,
      });
    }
    // React batches the destination and panel reveal into the same paint.
    onNavigate();
  };

  return (
    <div className="flex flex-col gap-2 pt-2" data-summary-contents="">
      <section aria-label="Environment">
        <div className={SECTION_LABEL}>Environment</div>
        <div className="max-h-40 overflow-y-auto overscroll-contain">
          {actions.map((action) => {
            const running = statuses[action.id]?.state === "running";
            const previewUrl = previewUrls[action.id];
            return (
              <div
                key={action.id}
                className="flex min-w-0 items-center gap-1"
                data-summary-run-action=""
              >
                <Button
                  variant="ghost"
                  className={cn(ROW, "w-auto flex-1")}
                  data-summary-run-trigger=""
                  aria-label={
                    running
                      ? `Open ${action.name} terminal`
                      : `Run ${action.name}`
                  }
                  onClick={() => {
                    if (running) {
                      openWorkbenchTerminal(folder, {
                        terminalId: runIdFor(action.id),
                        title: action.name,
                      });
                      onNavigate();
                    } else {
                      // Keep Summary in place so its live controls remain reachable.
                      startRun(action.id);
                    }
                  }}
                >
                  {running && active ? (
                    <RunWave size={16} />
                  ) : (
                    <DynamicIcon name={action.icon} className="size-4" />
                  )}
                  <Tooltip label={action.name} side="left">
                    <span className="text-fg1 min-w-0 flex-1 truncate">
                      {action.name}
                    </span>
                  </Tooltip>
                </Button>
                {running && (
                  <div
                    className="flex shrink-0 items-center gap-1"
                    role="group"
                    aria-label={`${action.name} run controls`}
                  >
                    <Tooltip
                      label={
                        previewUrl
                          ? `Open ${previewUrl} in Browser`
                          : "Waiting for a local preview address"
                      }
                    >
                      <span className="inline-flex">
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          className="text-fg2"
                          aria-label={`Open ${action.name} in Browser`}
                          disabled={!previewUrl}
                          onClick={() => {
                            if (previewUrl) openBrowser({ url: previewUrl });
                          }}
                        >
                          <ArrowUpRight className="size-4" aria-hidden="true" />
                        </Button>
                      </span>
                    </Tooltip>
                    <Tooltip label={`Stop ${action.name}`}>
                      <span className="inline-flex">
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          className="text-fg2"
                          aria-label={`Stop ${action.name}`}
                          onClick={(event) => {
                            // Stop disappears when the run exits. Keep keyboard
                            // focus on the stable action instead of losing it.
                            event.currentTarget
                              .closest("[data-summary-run-action]")
                              ?.querySelector<HTMLButtonElement>(
                                "[data-summary-run-trigger]",
                              )
                              ?.focus({ preventScroll: true });
                            stopRun(action.id);
                          }}
                        >
                          <Square className="size-3" aria-hidden="true" />
                        </Button>
                      </span>
                    </Tooltip>
                  </div>
                )}
              </div>
            );
          })}
          {actions.length === 0 &&
            (actionsReady ? (
              <Button variant="ghost" className={ROW} onClick={openRunSettings}>
                <Plus className="size-4" aria-hidden="true" />
                Add run action
              </Button>
            ) : (
              <p className="text-muted-fg px-1.5 py-1 text-xs">
                {actionsError
                  ? "Run actions unavailable."
                  : "Loading run actions…"}
              </p>
            ))}
        </div>
      </section>

      <nav
        aria-label="Workspace tools"
        className="border-border1 border-t pt-3"
      >
        {DESTINATIONS.map((type) => {
          const { icon: Icon, label } = TAB_TYPE_META[type];
          return (
            <Button
              key={type}
              variant="ghost"
              className={ROW}
              aria-label={type === "changes" ? "Changes" : undefined}
              aria-description={
                type === "changes" && hasChanges
                  ? `${changeLines.additions} additions, ${changeLines.deletions} deletions`
                  : undefined
              }
              onPointerEnter={() => warm(type)}
              onFocus={() => warm(type)}
              onClick={() => navigate(type)}
            >
              <Icon className="size-4" aria-hidden="true" />
              <span className="text-fg1">
                {type === "files" ? "Files" : label}
              </span>
              {type === "changes" && hasChanges && (
                <span
                  className="flex min-w-0 gap-1.5 text-xs tabular-nums"
                  data-summary-change-counts=""
                  aria-hidden="true"
                >
                  {changeLines.additions > 0 && (
                    <span className="text-green-primary">
                      +{changeLines.additions}
                    </span>
                  )}
                  {changeLines.deletions > 0 && (
                    <span className="text-red-primary">
                      −{changeLines.deletions}
                    </span>
                  )}
                </span>
              )}
            </Button>
          );
        })}
      </nav>

      <section
        aria-label="Recent context"
        className="border-border1 border-t pt-3"
      >
        {recent.length > 0 && <div className={SECTION_LABEL}>Context</div>}
        {recent.map((item) => {
          const Icon = item.kind === "image" ? Image : FileText;
          return (
            <Button
              key={item.relPath}
              variant="ghost"
              className={ROW}
              onPointerEnter={() => warm("context")}
              onFocus={() => warm("context")}
              onClick={() => navigate("context")}
            >
              <Icon className="text-muted-fg size-4" aria-hidden="true" />
              <Tooltip label={item.name} side="left">
                <span className="text-fg1 min-w-0 truncate">{item.name}</span>
              </Tooltip>
            </Button>
          );
        })}
        {recent.length === 0 && (
          <p className="text-muted-fg px-1.5 py-1 text-xs">
            {!isNativeRuntime()
              ? "Context is available in the desktop app."
              : !snapshot.data && snapshot.error
                ? "Couldn’t load context."
                : !snapshot.data
                  ? "Loading context…"
                  : "No context added yet"}
          </p>
        )}
        {recent.length > 0 && (
          <Button
            variant="ghost"
            className={ROW}
            onPointerEnter={() => warm("context")}
            onFocus={() => warm("context")}
            onClick={() => navigate("context")}
          >
            <Book className="text-muted-fg size-4" aria-hidden="true" />
            Show all
          </Button>
        )}
      </section>
    </div>
  );
}
