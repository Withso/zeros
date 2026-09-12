// Development-only transport. Real tab controls, terminal deck, and xterm;
// deterministic in-memory PTYs, without a native process or filesystem write.
import "../../../../../styles/zeros-tokens.css";
import "../../../../../styles/semantic-tokens.css";
import "../../../../../styles/globals.css";
import React, { useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { RuntimeClient } from "../platform/bridge/ws-client";
import { BridgeProvider } from "../platform/bridge/use-bridge";
import { type BridgeMessage } from "../platform/bridge/messages";
import {
  ActionsCtx,
  type SessionsCtx,
} from "../features/agent/sessions-context";
import { TooltipProvider } from "../shared/ui/primitives/tooltip";
import { loadProjects, upsertProject } from "../state/projects-store";
import { runSessionId } from "@zeros/protocol/run-actions";
import {
  selectWorkbench,
  useWorkspaceStore,
  workbenchScopeKey,
} from "../state/workspace-store";
import { useTerminalStore } from "../shell/terminal/terminal-store";
import { WorkbenchTabStrip } from "../shell/workbench/tab-strip";
import { TerminalPanel } from "../shell/workbench/tabs/terminal-tab";
import { visibleWorkbenchTabs } from "../shell/workbench/terminal-tabs";
import { addWorkbenchTerminal } from "../shell/workbench/open-terminal";
import { useWorkbenchFolder } from "../shell/workbench/use-workbench-folder";

const folderA = "/terminal-fixture/a";
const folderB = "/terminal-fixture/b";
upsertProject({ repoRoot: folderA, name: "Terminal A" });
upsertProject({ repoRoot: folderB, name: "Terminal B" });
const listeners = new Map<string, Set<(message: BridgeMessage) => void>>();
const nativeListeners = new Map<string, Set<(payload: unknown) => void>>();
const emit = (type: string, payload: Record<string, unknown> = {}) => {
  for (const callback of listeners.get(type) ?? [])
    callback({ type, ...payload } as BridgeMessage);
};
const ptys = new Map<
  string,
  { sessionId: string; cwd: string; createdAt: number; exited?: boolean }
>();
const messages: Array<Record<string, unknown>> = [];
const runStates: Record<string, Record<string, unknown>> = {};
const runLogs: Record<string, string> = {};
const pendingRuns = new Map<string, () => void>();
const setupStates = new Map<
  string,
  { state: "running" | "passed" | "failed" | "stopped"; log: string }
>();
const setupRunCounts = new Map<string, number>();
const pendingSetupRuns = new Map<
  string,
  { resolve(): void; reject(error: Error): void }
>();
let hasSetupCommand = true;
let runIcon = "flask-conical";
let runName = "Test";
let includeBuild = sessionStorage.getItem("terminal-fixture:build") === "true";
let includeRuns = true;
Object.defineProperty(RuntimeClient.prototype, "status", {
  get: () => "connected",
});
RuntimeClient.prototype.connect = () => Promise.resolve();
RuntimeClient.prototype.on = function (type, handler) {
  if (!listeners.has(type)) listeners.set(type, new Set());
  listeners.get(type)!.add(handler);
  return () => {
    listeners.get(type)?.delete(handler);
  };
};
RuntimeClient.prototype.send = function (raw) {
  const message = raw as Record<string, unknown>;
  messages.push(message);
  if (message.type === "PTY_WRITE")
    emit("PTY_DATA", { sessionId: message.sessionId, data: message.data });
  if (message.type === "PTY_KILL") {
    ptys.delete(String(message.sessionId));
    emit("PTY_TERMINALS_CHANGED");
  }
};
RuntimeClient.prototype.request = async function <
  T extends BridgeMessage = BridgeMessage,
>(raw: Partial<BridgeMessage> & { type: string }): Promise<T> {
  const message = raw as Record<string, unknown>;
  messages.push(message);
  if (message.type === "PTY_LIST")
    return {
      type: "PTY_LIST_RESULT",
      terminals: [...ptys.values()],
    } as unknown as T;
  if (message.type === "PTY_CREATE") {
    const sessionId = String(message.sessionId);
    ptys.set(sessionId, {
      sessionId,
      cwd: String(message.cwd),
      createdAt: Date.now(),
    });
    queueMicrotask(() => emit("PTY_TERMINALS_CHANGED"));
    return {
      ...message,
      type: "PTY_CREATED",
      pid: 1,
      reattached: true,
      replay: `${runLogs[sessionId] ?? ""}Ready ${message.cwd}\r\n$ `,
    } as unknown as T;
  }
  const params = (message.params ?? {}) as Record<string, unknown>;
  let result: unknown = {};
  if (message.op === "settings.resolve")
    result = {
      effective: {
        scripts: {
          run_actions: includeRuns
            ? [
                {
                  id: "test",
                  name: runName,
                  command: "pnpm test",
                  default: true,
                  icon: runIcon,
                },
                ...(includeBuild
                  ? [
                      {
                        id: "build",
                        name: "Build",
                        command: "pnpm build",
                        icon: "hammer",
                      },
                    ]
                  : []),
              ]
            : [],
        },
      },
      sources: {},
      warnings: [],
    };
  if (message.op === "workspace.list") result = { workspaces: [] };
  if (message.op === "file.tree")
    result = { files: ["scripts/setup.sh", "src/test.ts"] };
  if (message.op === "workspace.setupInfo")
    result = {
      ...(setupStates.get(String(params.workspaceId)) ?? {
        state: "passed",
        log: "Setup output preserved\r\n",
      }),
      hasCommand: hasSetupCommand,
      command: "pnpm install",
      truncated: false,
    };
  if (message.op === "workspace.rerunSetup") {
    const workspaceId = String(params.workspaceId);
    try {
      await new Promise<void>((resolve, reject) => {
        pendingSetupRuns.set(workspaceId, { resolve, reject });
      });
    } finally {
      pendingSetupRuns.delete(workspaceId);
    }
    if (hasSetupCommand) {
      const count = (setupRunCounts.get(workspaceId) ?? 0) + 1;
      setupRunCounts.set(workspaceId, count);
      setupStates.set(workspaceId, {
        state: "running",
        log: `Fresh setup run ${count}: dependencies ready\r\n`,
      });
      emit("DB_CHANGED", {
        kinds: ["setup", "workspaces"],
        workspaceIds: [workspaceId],
      });
    }
    result = { ok: hasSetupCommand, hasCommand: hasSetupCommand };
  }
  if (message.op === "workspace.stopSetup") {
    const workspaceId = String(params.workspaceId);
    setupStates.set(workspaceId, {
      state: "stopped",
      log: setupStates.get(workspaceId)?.log ?? "",
    });
    emit("DB_CHANGED", {
      kinds: ["setup", "workspaces"],
      workspaceIds: [workspaceId],
    });
    result = { ok: true };
  }
  if (message.op === "workspace.runInfo")
    result = { actions: runStates[String(params.workspaceId)] ?? {} };
  if (message.op === "workspace.runLog")
    result = { log: runLogs[String(params.sessionId)] ?? "", truncated: false };
  if (message.op === "workspace.startRun") {
    await new Promise<void>((resolve) => {
      pendingRuns.set(String(params.actionId), resolve);
    });
    pendingRuns.delete(String(params.actionId));
    const sessionId = String(params.sessionId);
    runLogs[sessionId] = "";
    const folder = String(params.repoRoot);
    ptys.set(sessionId, { sessionId, cwd: folder, createdAt: Date.now() });
    runStates[String(params.workspaceId)] = {
      ...runStates[String(params.workspaceId)],
      [String(params.actionId)]: {
        state: "running",
        sessionId,
        startedAt: Date.now(),
      },
    };
    emit("DB_CHANGED", { kinds: ["workspaces"] });
    emit("PTY_TERMINALS_CHANGED");
    result = { ok: true, hasCommand: true, alreadyRunning: false };
  }
  if (message.op === "workspace.stopRun") {
    const statuses = runStates[String(params.workspaceId)] ?? {};
    const actionId = Object.keys(statuses).find(
      (id) =>
        (statuses[id] as { sessionId?: string }).sessionId === params.sessionId,
    );
    runStates[String(params.workspaceId)] = {
      ...statuses,
      ...(actionId
        ? {
            [actionId]: {
              state: "stopped",
              sessionId: params.sessionId,
              endedAt: Date.now(),
            },
          }
        : {}),
    };
    emit("DB_CHANGED", { kinds: ["workspaces"] });
    result = { ok: true };
  }
  return { type: "WORKSPACE_RESPONSE", result } as unknown as T;
};
window.__ZEROS_NATIVE__ = {
  invoke: async <T,>(command: string) =>
    (command === "get_engine_root" ? "/terminal-fixture/ambient" : null) as T,
  on: (name, callback) => {
    if (!nativeListeners.has(name)) nativeListeners.set(name, new Set());
    const listener = callback as (payload: unknown) => void;
    nativeListeners.get(name)!.add(listener);
    return () => {
      nativeListeners.get(name)?.delete(listener);
    };
  },
};
useWorkspaceStore.setState({
  chats: [],
  activeChatId: null,
  newAgentFolder: folderA,
  activePage: "workspace",
});
Object.assign(window, {
  __zerosTerminalSmoke: {
    messages,
    finishRun: (actionId?: string) =>
      (actionId
        ? pendingRuns.get(actionId)
        : pendingRuns.values().next().value)?.(),
    pendingRun: () => pendingRuns.size > 0,
    finishSetupRequest: (workspaceId: string) =>
      pendingSetupRuns.get(workspaceId)?.resolve(),
    failSetupRequest: (workspaceId: string) =>
      pendingSetupRuns
        .get(workspaceId)
        ?.reject(new Error("Setup fixture failure")),
    completeSetup: (
      workspaceId: string,
      state: "passed" | "failed" | "stopped" = "passed",
    ) => {
      setupStates.set(workspaceId, {
        state,
        log: setupStates.get(workspaceId)?.log ?? "",
      });
      emit("DB_CHANGED", {
        kinds: ["setup", "workspaces"],
        workspaceIds: [workspaceId],
      });
    },
    setSetupCommand: (value: boolean) => {
      hasSetupCommand = value;
    },
    addBuildAction: () => {
      includeBuild = true;
      sessionStorage.setItem("terminal-fixture:build", "true");
      emit("DB_CHANGED", { kinds: ["settings"] });
    },
    removeRunActions: () => {
      includeRuns = false;
      emit("DB_CHANGED", { kinds: ["settings"] });
    },
    setRunIcon: (icon: string) => {
      runIcon = icon;
      emit("DB_CHANGED", { kinds: ["settings"] });
    },
    setRunName: (name: string) => {
      runName = name;
      emit("DB_CHANGED", { kinds: ["settings"] });
    },
    state: () => selectWorkbench(useWorkspaceStore.getState()),
    sessions: () => useTerminalStore.getState().sessions,
    restoreLastFolder: () =>
      useWorkspaceStore.setState({
        chats: [],
        activeChatId: null,
        newAgentFolder: null,
        lastWorkspaceFolder: folderA,
      }),
    adoptTerminal: (sessionId: string) => {
      ptys.set(sessionId, { sessionId, cwd: folderA, createdAt: Date.now() });
      emit("PTY_TERMINALS_CHANGED");
    },
    renameTerminal: (id: string, title: string) =>
      useTerminalStore.getState().renameSession(id, title),
    shortcutListeners: () => nativeListeners.get("run-shortcut")?.size ?? 0,
    runShortcut: () => {
      for (const callback of nativeListeners.get("run-shortcut") ?? [])
        callback(undefined);
    },
    runIdFor: (actionId: string) =>
      runSessionId(workbenchScopeKey(useWorkspaceStore.getState()), actionId),
    navigation: () => {
      const state = useWorkspaceStore.getState();
      return {
        page: state.activePage,
        repoRoot: loadProjects().find((p) => p.id === state.activeRepoId)
          ?.repoRoot,
        view: state.activeRepoId
          ? state.repoPageViewByProject[state.activeRepoId]
          : null,
      };
    },
    returnToWorkspace: () =>
      useWorkspaceStore
        .getState()
        .dispatch({ type: "SET_ACTIVE_PAGE", page: "workspace" }),
    changed: () => {
      emit("DB_CHANGED", { kinds: ["workspaces"] });
      emit("PTY_TERMINALS_CHANGED");
    },
    output: (sessionId: string, data: string) => {
      runLogs[sessionId] = (runLogs[sessionId] ?? "") + data;
      emit("PTY_DATA", { sessionId, data });
    },
    exit: (sessionId: string) =>
      emit("PTY_EXIT", { sessionId, exitCode: 0, signal: null }),
    addMany: () => {
      for (let index = 0; index < 18; index += 1)
        addWorkbenchTerminal(workbenchScopeKey(useWorkspaceStore.getState()));
    },
  },
});

function Harness() {
  const { folderKey: folder, chatCwd } = useWorkbenchFolder();
  const workbench = useWorkspaceStore(selectWorkbench);
  const tabs = useMemo(
    () => visibleWorkbenchTabs(workbench.tabs),
    [workbench.tabs],
  );
  const terminalActive = tabs.some(
    (tab) => tab.id === workbench.activeId && tab.type === "terminal",
  );
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  const [active, setActive] = useState(true);
  return (
    <div className="bg-bg1 text-fg1 flex h-screen flex-col">
      <nav className="flex min-h-10 shrink-0 flex-wrap items-center gap-x-4 px-4">
        <button
          onClick={() =>
            useWorkspaceStore
              .getState()
              .dispatch({ type: "SET_NEW_AGENT_FOLDER", folder: folderA })
          }
        >
          Workspace A
        </button>
        <button
          onClick={() =>
            useWorkspaceStore
              .getState()
              .dispatch({ type: "SET_NEW_AGENT_FOLDER", folder: folderB })
          }
        >
          Workspace B
        </button>
        <button onClick={() => setActive((value) => !value)}>
          Toggle workspace visibility
        </button>
        <button
          onClick={() =>
            useWorkspaceStore.setState({
              newAgentFolder: null,
              activeChatId: null,
              lastWorkspaceFolder: null,
            })
          }
        >
          No workspace
        </button>
      </nav>
      <div
        ref={containerRef}
        className="relative flex min-h-0 flex-1 flex-col overflow-hidden"
        {...(!active ? { inert: "" } : {})}
        style={!active ? { visibility: "hidden" } : undefined}
      >
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <div className="flex h-10 shrink-0 items-center pr-2">
            <div className="h-full min-w-0 flex-1">
              <WorkbenchTabStrip
                tabs={tabs}
                activeId={workbench.activeId}
                folderKey={folder}
                workspaceId={null}
              />
            </div>
          </div>
          <div className="relative min-h-0 flex-1">
            {!terminalActive && (
              <div className="p-4">Files and workspace content</div>
            )}
            <div
              ref={setHost}
              className="absolute inset-0 flex flex-col"
              {...(!terminalActive ? { inert: "" } : {})}
              aria-hidden={!terminalActive}
              style={!terminalActive ? { visibility: "hidden" } : undefined}
            />
          </div>
        </div>
        <TerminalPanel
          folderKey={folder}
          chatCwd={chatCwd}
          surfaceActive={active}
          containerRef={containerRef}
          workbenchHost={host}
        />
      </div>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(
  <BridgeProvider>
    <ActionsCtx.Provider value={{} as SessionsCtx}>
      <TooltipProvider>
        <Harness />
      </TooltipProvider>
    </ActionsCtx.Provider>
  </BridgeProvider>,
);
