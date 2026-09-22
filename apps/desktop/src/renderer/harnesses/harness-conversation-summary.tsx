// Browser contract for the real Summary controls, caches and navigation.
// Only engine/native transport is replaced; no filesystem or PTY is touched.
import "../../../../../styles/zeros-tokens.css";
import "../../../../../styles/semantic-tokens.css";
import "../../../../../styles/globals.css";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { RuntimeClient } from "../platform/bridge/ws-client";
import { BridgeProvider } from "../platform/bridge/use-bridge";
import type { BridgeMessage } from "../platform/bridge/messages";
import {
  notifyContextGraphChanged,
  type ContextGraphItemWire,
} from "../platform/context-graph";
import { TooltipProvider, Button } from "../shared/ui/primitives";
import { listenForNativeSurfaceOverlayIntent } from "../shared/ui/native-surface-overlay";
import {
  OPEN_OVERLAY_SELECTOR,
  shouldReclaimComposerFocus,
} from "../features/agent/composer-focus";
import { upsertProject } from "../state/projects-store";
import { selectWorkbench, useWorkspaceStore } from "../state/workspace-store";
import { useChatPanesStore } from "../state/chat-panes-store";
import { DEFAULT_PANE_LAYOUT, splitLeaf } from "../state/chat-panes";
import { triggerGitRefresh } from "../shell/use-git-refresh-key";
import {
  ConversationSummaryProvider,
  ConversationSummaryTrigger,
  ConversationSummaryIsland,
} from "../shell/conversation/conversation-summary";

const folderA = "/summary-fixture/a";
const folderB = "/summary-fixture/b";
// This fixture exercises every destination, including GitHub Review. Plain
// folder and local-only Review absence live in harness-folder-workspace.
upsertProject({
  repoRoot: folderA,
  repoSlug: "a",
  name: "Summary A",
  isGitRepository: true,
  originUrl: "https://github.com/example/summary-a.git",
});
upsertProject({
  repoRoot: folderB,
  repoSlug: "b",
  name: "Summary B",
  isGitRepository: true,
  originUrl: "https://github.com/example/summary-b.git",
});
const listeners = new Map<string, Set<(message: BridgeMessage) => void>>();
const messages: Array<Record<string, unknown>> = [];
const overlayIntents: boolean[] = [];
listenForNativeSurfaceOverlayIntent((open) => overlayIntents.push(open));
let failContext = false;
let delayContext = false;
let releaseContext: (() => void) | undefined;
let runCount = 2;
const runs = new Map<string, Record<string, unknown>>();
let previewLog = "Local: http://localhost:5173/\n";
let changeLines = { additions: 54364, deletions: 3 };
let failLines = false;
let delayLines = false;
let releaseLines: (() => void) | undefined;
let contextItems = [
  "Earlier notes.md",
  "Design reference.png",
  "Latest screenshot with a very long name that should truncate.png",
  "Implementation plan.md",
];
const emit = (type: string, payload: Record<string, unknown> = {}) => {
  for (const callback of listeners.get(type) ?? [])
    callback({ type, ...payload } as BridgeMessage);
};
Object.defineProperty(RuntimeClient.prototype, "status", {
  get: () => "connected",
});
RuntimeClient.prototype.connect = () => Promise.resolve();
RuntimeClient.prototype.forceReconnect = () => Promise.resolve();
RuntimeClient.prototype.on = function (type, handler) {
  if (!listeners.has(type)) listeners.set(type, new Set());
  listeners.get(type)!.add(handler);
  return () => {
    listeners.get(type)?.delete(handler);
  };
};
RuntimeClient.prototype.send = () => {};
RuntimeClient.prototype.request = async function <
  T extends BridgeMessage = BridgeMessage,
>(raw: Partial<BridgeMessage> & { type: string }): Promise<T> {
  const message = raw as Record<string, unknown>;
  messages.push(message);
  const params = (message.params ?? {}) as Record<string, unknown>;
  let result: unknown = {};
  if (message.op === "workspace.list") result = { workspaces: [] };
  if (message.op === "settings.resolve")
    result = {
      effective: {
        scripts: {
          run_actions: Array.from({ length: runCount }, (_, index) => ({
            id: `action-${index}`,
            name: index === 0 ? "Dev server" : `Test suite ${index}`,
            command: "echo fixture",
            icon: index === 0 ? "play" : "flask-conical",
            default: index === 0,
          })),
        },
      },
      sources: {},
      warnings: [],
    };
  if (message.op === "context.graph.list") {
    const names =
      params.workspaceId === folderB ? ["Workspace B notes.md"] : contextItems;
    const items: ContextGraphItemWire[] = names.map((name, index) => ({
      name,
      relPath: `.context/local/attachments/${index}/${name}`,
      scope: "local",
      category: "attachment",
      kind: name.endsWith("png") ? "image" : "markdown",
      bytes: 10,
      mtimeMs: index + 1,
    }));
    if (delayContext && params.workspaceId === folderA)
      await new Promise<void>((resolve) => {
        releaseContext = resolve;
      });
    if (failContext) throw new Error("Context fixture failure");
    result = { exists: true, items, truncated: false };
  }
  if (message.op === "file.tree") result = { files: [] };
  if (message.op === "file.ignoredEntries")
    result = { entries: [], truncated: false };
  if (message.op === "workspace.runInfo")
    result = { actions: { ...runs.get(String(params.workspaceId)) } };
  if (message.op === "workspace.runLog")
    result = { log: previewLog, truncated: false };
  if (message.op === "workspace.startRun") {
    const statuses = runs.get(String(params.workspaceId)) ?? {};
    statuses[String(params.actionId)] = {
      state: "running",
      startedAt: Date.now(),
      sessionId: params.sessionId,
    };
    runs.set(String(params.workspaceId), statuses);
    emit("DB_CHANGED", {
      kinds: ["workspaces"],
      workspaceIds: [params.workspaceId],
    });
    result = { ok: true, hasCommand: true, alreadyRunning: false };
  }
  if (message.op === "workspace.stopRun") {
    const statuses = runs.get(String(params.workspaceId)) ?? {};
    for (const [id, value] of Object.entries(statuses)) {
      const status = value as { sessionId: string };
      if (status.sessionId === params.sessionId)
        statuses[id] = { ...status, state: "stopped" };
    }
    emit("DB_CHANGED", {
      kinds: ["workspaces"],
      workspaceIds: [params.workspaceId],
    });
    result = { ok: true };
  }
  if (message.op === "git.changeLineCounts") {
    result =
      params.workspaceId === folderB
        ? { additions: 0, deletions: 7 }
        : changeLines;
    if (delayLines && params.workspaceId === folderA) {
      delayLines = false;
      await new Promise<void>((resolve) => {
        releaseLines = resolve;
      });
    }
    if (failLines) throw new Error("Diff fixture failure");
  }
  return { type: "WORKSPACE_RESPONSE", result } as unknown as T;
};
window.__ZEROS_NATIVE__ = {
  invoke: async <T,>() => null as T,
  on: () => () => {},
};
useWorkspaceStore.setState({
  chats: [],
  activeChatId: null,
  newAgentFolder: folderA,
  activePage: "workspace",
});
Object.assign(window, {
  __summaryHarness: {
    messages,
    overlayIntent: () => overlayIntents.at(-1) ?? false,
    state: () => selectWorkbench(useWorkspaceStore.getState()),
    setRuns: (count: number) => {
      runCount = count;
      emit("DB_CHANGED", { kinds: ["settings"] });
    },
    setPreviewLog: (log: string) => {
      previewLog = log;
    },
    setSplit: (split: boolean) =>
      useChatPanesStore.setState({
        byFolder: split
          ? {
              [folderA]: splitLeaf(
                DEFAULT_PANE_LAYOUT,
                "main",
                "row",
                "right",
              )!,
            }
          : {},
      }),
    changeLines: (additions: number, deletions: number) => {
      changeLines = { additions, deletions };
      triggerGitRefresh(folderA);
    },
    failLines: (value: boolean) => {
      failLines = value;
      triggerGitRefresh(folderA);
    },
    delayLines: () => {
      delayLines = true;
      triggerGitRefresh(folderA);
    },
    releaseLines: () => {
      delayLines = false;
      releaseLines?.();
    },
    changeContext: (names: string[]) => {
      contextItems = names;
      notifyContextGraphChanged(folderA);
    },
    failContext: (value: boolean) => {
      failContext = value;
      notifyContextGraphChanged(folderA);
    },
    delayContext: () => {
      delayContext = true;
      notifyContextGraphChanged(folderA);
    },
    releaseContext: () => {
      delayContext = false;
      releaseContext?.();
    },
    switchFolder: (folder: "a" | "b") =>
      useWorkspaceStore.getState().dispatch({
        type: "SET_NEW_AGENT_FOLDER",
        folder: folder === "a" ? folderA : folderB,
      }),
    hide: () =>
      useWorkspaceStore
        .getState()
        .dispatch({ type: "SET_ACTIVE_PAGE", page: "settings" }),
    show: () =>
      useWorkspaceStore
        .getState()
        .dispatch({ type: "SET_ACTIVE_PAGE", page: "workspace" }),
  },
});

function Harness() {
  const [collapsed, setCollapsed] = useState(true);
  const [narrow, setNarrow] = useState(false);
  const workbench = useWorkspaceStore(selectWorkbench);
  const reveal = useCallback(() => setCollapsed(false), []);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  // Exercise the production composer's focus policy around a new chat overlay.
  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      const composer = composerRef.current;
      const paneRoot = composer?.closest("[data-pane-root]");
      if (
        !event.detail ||
        !composer ||
        !paneRoot?.contains(event.target as Node)
      )
        return;
      setTimeout(() => {
        if (
          shouldReclaimComposerFocus({
            owns: true,
            interactionInsidePane: true,
            composerHasFocus: document.activeElement === composer,
            hasTextSelection: !window.getSelection()?.isCollapsed,
            hasOpenOverlay: !!document.querySelector(OPEN_OVERLAY_SELECTOR),
            activeElement: document.activeElement,
            paneRoot,
          })
        )
          composer.focus();
      }, 0);
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, []);
  return (
    <main className="bg-bg1 text-fg1 flex h-screen flex-col">
      <nav className="border-border1 flex h-10 shrink-0 items-center gap-4 border-b px-4">
        <Button variant="ghost" onClick={() => setCollapsed((value) => !value)}>
          Toggle workbench
        </Button>
        <Button variant="ghost" onClick={() => setNarrow((value) => !value)}>
          Toggle narrow pane
        </Button>
        <output data-testid="destination">
          {workbench.tabs.find((tab) => tab.id === workbench.activeId)?.type}
        </output>
      </nav>
      <div className="flex min-h-0 flex-1">
        <section
          data-zeros-column-2=""
          data-popover-boundary=""
          data-pane-root=""
          className="relative flex min-h-0 min-w-0 flex-col"
          style={{ width: narrow ? 380 : collapsed ? "100%" : "60%" }}
        >
          <ConversationSummaryProvider
            workbenchCollapsed={collapsed}
            onRevealWorkbench={reveal}
          >
            <div className="flex h-10 shrink-0 items-center gap-2 px-3">
              <span className="text-fg2 flex-1 text-xs">Untitled chat</span>
              <ConversationSummaryTrigger />
              {collapsed && (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Expand workbench"
                  onClick={reveal}
                >
                  ↔
                </Button>
              )}
            </div>
            <div className="flex min-h-0 min-w-0 flex-1">
              <div
                className="flex min-w-0 flex-1 flex-col justify-between p-4"
                data-testid="chat-body"
              >
                <p className="text-fg2 text-xs">
                  Conversation stays visible beside the Summary.
                </p>
                <textarea
                  ref={composerRef}
                  aria-label="Message"
                  placeholder="Send follow up"
                  className="bg-bg1-highlight border-border1 w-full rounded-lg border p-3"
                />
              </div>
              <ConversationSummaryIsland />
            </div>
          </ConversationSummaryProvider>
        </section>
        {!collapsed && (
          <div
            data-testid="workbench"
            className="border-border1 flex-1 border-l p-4 text-xs"
          >
            Workspace tools
          </div>
        )}
      </div>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(
  <BridgeProvider>
    <TooltipProvider>
      <Harness />
    </TooltipProvider>
  </BridgeProvider>,
);
