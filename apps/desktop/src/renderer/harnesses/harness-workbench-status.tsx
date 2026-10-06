// Real tab frame, availability subscriptions, keyed cache and feature surfaces.
// The transport is in memory; no workspace, provider or native process is used.
import "../../../../../styles/zeros-tokens.css";
import "../../../../../styles/semantic-tokens.css";
import "../../../../../styles/globals.css";
import { useCallback, useEffect, useSyncExternalStore } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { WorkspaceRuntimeClient } from "../platform/bridge/workspace-runtime-client";
import type { ConnectionStatus } from "../platform/bridge/ws-client";
import type { BridgeMessage } from "../platform/bridge/messages";
import { setActiveBridge } from "../platform/bridge/active-bridge";
import { recordWorkbenchConnectionFailure } from "../state/workbench-availability";
import { cloudWorkspaceKey } from "../platform/bridge/cloud-workspace-key";
import type { CloudWorkspaceDocument } from "../platform/cloud-workspaces";
import {
  acceptCloudWorkspaceDocument,
  getCloudWorkspaceRows,
} from "../state/cloud-workspace-catalog";
import { KeyedAsyncCache } from "../shared/lib/keyed-async-cache";
import { PanelHeader, TooltipProvider } from "../shared/ui/primitives";
import { Toaster } from "../shared/ui/primitives/elements/toast";
import { cn } from "../shared/ui/cn";
import {
  WorkbenchTabFrame,
  WorkbenchTabToolbar,
  useWorkbenchStatusSource,
} from "../shell/workbench/tab-status";
import {
  TAB_TYPE_META,
  type WorkbenchTab,
  type WorkbenchTabType,
} from "../shell/workbench/tab-model";
import { workbenchStatusKey } from "../shell/workbench/tab-status-model";
import { FileViewer } from "../shell/workbench/tabs/file-viewer";
import { ChangesScopeMenu } from "../shell/workbench/tabs/changes-scope-menu";
import { DesignWorkbenchSurface } from "../features/design-workspace/design-workbench-surface";
import { ReviewView } from "../shell/workbench/tabs/review-tab";
import { BrowserTab } from "../shell/workbench/tabs/browser-tab";
import {
  ActionsCtx,
  type SessionsCtx,
} from "../features/agent/sessions-context";
import type { ReviewProvider } from "../shell/pr/review-provider";
import { invalidateWorkspaceFileData } from "../shell/workspace-file-data-cache";
import {
  designCheckoutStatusCache,
  designDirectoryTargetCache,
} from "../state/read-caches";
import { designDirectoryTargetKeyForWorkspace } from "../state/design-directory-target";
import { prefetchReviewLiveData } from "../shell/workbench/tabs/review-data";

const targets = {
  a: {
    organizationId: "11111111-1111-4111-8111-111111111111",
    workspaceId: "22222222-2222-4222-8222-222222222222",
  },
  b: {
    organizationId: "11111111-1111-4111-8111-111111111111",
    workspaceId: "33333333-3333-4333-8333-333333333333",
  },
};
const documents = new Map<string, CloudWorkspaceDocument>();
for (const target of Object.values(targets)) {
  const document: CloudWorkspaceDocument = {
    id: target.workspaceId,
    organizationId: target.organizationId,
    teamId: target.organizationId,
    createdBy: target.organizationId,
    name: "Status fixture",
    placement: "cloud",
    status: "ready",
    version: 1,
    error: null,
    createdAt: "2026-09-26T10:00:00Z",
    updatedAt: "2026-09-26T10:00:00Z",
    deletedAt: null,
    capabilities: {
      canWrite: true,
      canManage: true,
      canStart: true,
      startUnavailableReason: null,
    },
    repository: {
      forge: "github.com",
      owner: "example",
      name: "fixture",
      revision: "refs/heads/main",
    },
    generation: {
      number: 1,
      architecture: "x86_64",
      resources: { cpuMillicores: 2000, memoryMiB: 4096, storageMiB: 20480 },
      observedState: "running",
      lastObservedAt: null,
    },
  };
  documents.set(cloudWorkspaceKey(target), document);
  acceptCloudWorkspaceDocument(document);
}
const reads: { folder: string; op: string }[] = [];
const failures = new Map<string, string>();
const secondaryFailures = new Map<string, string>();
const readCache = new KeyedAsyncCache<string>(32);
let holdReads = false;
const pendingReads: (() => void)[] = [];
const listeners = new Set<() => void>();
let revision = 0;

class FixtureBridge extends WorkspaceRuntimeClient {
  connections = new Map(
    Object.values(targets).map((target) => [
      cloudWorkspaceKey(target),
      (new URLSearchParams(location.search).has("cold")
        ? "disconnected"
        : "connected") as ConnectionStatus,
    ]),
  );
  fixtureStatusListeners = new Map<string, Set<() => void>>();
  reconnects = 0;
  constructor() {
    super({
      open: async () => {
        throw new Error("Fixture admission only");
      },
      workspaces: () => [],
    });
  }
  override statusForWorkspace(folder?: string | null) {
    return this.connections.get(folder ?? "") ?? "connected";
  }
  override onWorkspaceStatusChange(folder: string, callback: () => void) {
    const subscribers = this.fixtureStatusListeners.get(folder) ?? new Set();
    subscribers.add(callback);
    this.fixtureStatusListeners.set(folder, subscribers);
    callback();
    return () => {
      subscribers.delete(callback);
    };
  }
  connection(folder: string, connection: ConnectionStatus) {
    this.connections.set(folder, connection);
    for (const callback of this.fixtureStatusListeners.get(folder) ?? [])
      callback();
    publish();
  }
  override async warmWorkspace(target: typeof targets.a) {
    this.reconnects++;
    this.connection(cloudWorkspaceKey(target), "connected");
  }
  override async request<T extends BridgeMessage = BridgeMessage>(
    message: Partial<BridgeMessage> & { type: string },
  ): Promise<T> {
    const request = message as unknown as {
      op?: string;
      params?: { workspaceId?: string; cwd?: string; path?: string };
    };
    const folder = request.params?.cwd ?? config.folder;
    reads.push({ folder, op: request.op ?? message.type });
    if (holdReads)
      await new Promise<void>((resolve) => pendingReads.push(resolve));
    const failure = failures.get(folder);
    if (failure) throw new Error(failure);
    let result: unknown = {};
    if (request.op === "fixture.read")
      result = `Confirmed ${TAB_TYPE_META[config.type].label} content`;
    if (request.op === "file.read")
      result = {
        kind: "text",
        bytes: 24,
        path: request.params?.path,
        content: "Confirmed file content\n",
      };
    if (request.op === "git.status")
      result = {
        staged: [],
        unstaged: [],
        untracked: [],
        conflicted: [],
        conflictState: null,
      };
    if (request.op === "codeReview.list")
      result = {
        workspaceId: request.params?.workspaceId,
        threads: [],
        partial: false,
      };
    if (request.op === "git.diff") result = { hunks: [], patch: "" };
    if (request.op === "design.listDirectories")
      result = {
        directories: [],
        target: { directory: "design", exists: false },
      };
    if (request.op === "design.status")
      result = { conflicts: [], paused: false, operation: null };
    return { type: "WORKSPACE_RESPONSE", result } as unknown as T;
  }
}
const bridge = new FixtureBridge();
setActiveBridge(bridge);
const provider: ReviewProvider = {
  family: "github",
  cacheKey: "github:status-fixture",
  hostOrigin: "github.com",
  hostLabel: "GitHub",
  capabilities: { reviewNoun: "pull request", mergeMethods: [] },
  authStatus: async () => ({ authenticated: true }),
  getPr: async () => {
    const failure = failures.get(config.folder);
    if (failure) throw new Error(failure);
    return {
      number: 42,
      url: "https://github.com/example/fixture/pull/42",
      state: "ready",
      title: "Confirmed review",
      body: "Confirmed description",
      authorLogin: "fixture",
      baseBranch: "main",
      headBranch: "feature",
      mergeableState: "clean",
      isMergeable: true,
      createdAt: 1,
      updatedAt: 1,
      mergedAt: null,
    };
  },
  getChecks: async () => ({
    checks: [],
    deployments: [],
    total: 0,
    passed: 0,
    failed: 0,
    pending: 0,
  }),
  getCommits: async () => [],
  getTimeline: async () => [],
  addComment: async () => ({ id: 1, url: "" }),
  merge: async () => ({ sha: "fixture" }),
  markReady: async () => {
    throw new Error("No fixture writes");
  },
};
let config: {
  type: WorkbenchTabType;
  folder: string;
  target: string;
  active: boolean;
  copies: number;
  surface: "contract" | "feature";
} = {
  type: "files",
  folder: cloudWorkspaceKey(targets.a),
  target: "one",
  active: true,
  copies: 1,
  surface: "contract",
};
function publish() {
  revision++;
  for (const callback of listeners) callback();
}
function ContractBody({
  tab,
  folder,
  active,
  version,
}: {
  tab: WorkbenchTab;
  folder: string;
  active: boolean;
  version: number;
}) {
  const key = workbenchStatusKey(folder, tab);
  const subscribe = useCallback(
    (callback: () => void) =>
      active ? readCache.subscribe(key, callback) : () => {},
    [active, key],
  );
  const snapshot = useSyncExternalStore(subscribe, () =>
    readCache.getSnapshot(key),
  );
  const load = useCallback(
    () =>
      readCache
        .load(
          key,
          async () => {
            const reply = await bridge.request({
              type: "WORKSPACE_REQUEST",
              op: "fixture.read",
              params: { cwd: folder },
            } as never);
            return (reply as unknown as { result: string }).result;
          },
          { force: true },
        )
        .catch(() => {}),
    [folder, key],
  );
  const connection = bridge.statusForWorkspace(folder);
  useEffect(() => {
    if (active && connection === "connected") void load();
  }, [active, connection, load, version]);
  useWorkbenchStatusSource(
    {
      primary: true,
      error: snapshot.error,
      pending: snapshot.loading || snapshot.refreshing,
      hasContent: snapshot.data !== undefined,
      retry: load,
    },
    key,
  );
  useWorkbenchStatusSource(
    {
      error: secondaryFailures.get(folder),
      pending: false,
      retry: async () => {
        secondaryFailures.delete(folder);
        publish();
      },
    },
    "comments",
  );
  return (
    <>
      <WorkbenchTabToolbar>
        <PanelHeader size="panel">
          {tab.title}
          {tab.type === "changes" && (
            <ChangesScopeMenu
              scope={{ kind: "all" }}
              commits={[]}
              turns={[]}
              changeCounts={{ all: 0, uncommitted: 0, staged: 0, unstaged: 0 }}
              onChange={() => {}}
              commitsError={secondaryFailures.get(folder)}
            />
          )}
        </PanelHeader>
      </WorkbenchTabToolbar>
      {snapshot.data && (
        <div
          data-confirmed-content=""
          className="text-fg2 flex flex-1 items-center justify-center p-4 text-xs"
        >
          {snapshot.data}
        </div>
      )}
    </>
  );
}
function FeatureBody({ folder, tab }: { folder: string; tab: WorkbenchTab }) {
  const id = folder;
  const workspace = getCloudWorkspaceRows().find((row) => row.path === folder)!;
  if (tab.type === "browser")
    return (
      <ActionsCtx.Provider
        value={{ getSession: () => undefined } as unknown as SessionsCtx}
      >
        <BrowserTab
          tab={{
            ...tab,
            url: `http://status-preview.invalid/${encodeURIComponent(tab.filePath ?? "")}`,
          }}
          scope="/fixture"
          active={config.active}
        />
      </ActionsCtx.Provider>
    );
  if (tab.type === "design")
    return (
      <DesignWorkbenchSurface
        folder={folder}
        workspace={workspace}
        active={config.active}
      />
    );
  if (tab.type === "review")
    return (
      <ReviewView
        provider={provider}
        workspaceId={id}
        cwd={folder}
        baseBranch="main"
        branch="feature"
        prNumber={42}
        prUrl={null}
        repoSlug="example/fixture"
        refreshKey={revision}
        sub="description"
        active={config.active}
        onSubChange={() => {}}
        agentWorking={false}
      />
    );
  return (
    <FileViewer
      tabId="fixture-file"
      cwd={folder}
      workspaceId={id}
      path="fixture.txt"
      active={config.active}
      refreshKey={revision}
    />
  );
}
function Harness() {
  const version = useSyncExternalStore(
    (callback) => {
      listeners.add(callback);
      return () => {
        listeners.delete(callback);
      };
    },
    () => revision,
  );
  const tab: WorkbenchTab = {
    id: config.type,
    type: config.type,
    title: TAB_TYPE_META[config.type].label,
    filePath: config.surface === "feature" ? config.target : undefined,
    diffSha: config.target,
    terminalId: config.target,
  };
  return (
    <TooltipProvider>
      <main className="bg-bg1 text-fg1 flex h-screen min-w-0">
        {Array.from({ length: config.copies }, (_, index) => (
          <section
            key={index}
            aria-label={`${tab.title} fixture ${index + 1}`}
            className={cn(
              "border-border1 flex min-w-0 flex-1 flex-col border-r",
              !config.active && "hidden",
            )}
            {...(!config.active ? { inert: "", "aria-hidden": true } : {})}
          >
            <WorkbenchTabFrame
              tab={tab}
              folder={config.folder}
              active={config.active}
            >
              {config.surface === "feature" ? (
                <FeatureBody tab={tab} folder={config.folder} />
              ) : (
                <ContractBody
                  tab={tab}
                  folder={config.folder}
                  active={config.active}
                  version={version}
                />
              )}
            </WorkbenchTabFrame>
          </section>
        ))}
      </main>
      <Toaster />
    </TooltipProvider>
  );
}
const root = createRoot(document.getElementById("root")!);
const fixture = {
  reads,
  bridge,
  render(
    type: WorkbenchTabType,
    options: Partial<Omit<typeof config, "type" | "folder">> & {
      workspace?: "a" | "b";
    } = {},
  ) {
    config = {
      ...config,
      ...options,
      type,
      folder: cloudWorkspaceKey(targets[options.workspace ?? "a"]),
    };
    flushSync(() => root.render(<Harness />));
    publish();
  },
  state(state: CloudWorkspaceDocument["status"]) {
    const doc = {
      ...documents.get(config.folder)!,
      status: state,
      version: documents.get(config.folder)!.version + 1,
    };
    documents.set(config.folder, doc);
    acceptCloudWorkspaceDocument(doc);
    publish();
  },
  connection(status: ConnectionStatus) {
    bridge.connection(config.folder, status);
  },
  connectFailure(kind: "connect" | "open" = "connect") {
    recordWorkbenchConnectionFailure(
      config.folder,
      new Error("Engine unavailable"),
      kind,
    );
  },
  fail(message: string | null, secondary = false) {
    const map = secondary ? secondaryFailures : failures;
    if (message) map.set(config.folder, message);
    else map.delete(config.folder);
    publish();
  },
  hold(value: boolean) {
    holdReads = value;
  },
  release() {
    holdReads = false;
    for (const resolve of pendingReads.splice(0)) resolve();
  },
  async refreshFeature() {
    const id = config.folder;
    invalidateWorkspaceFileData(config.folder, id);
    designDirectoryTargetCache.invalidate(
      designDirectoryTargetKeyForWorkspace(id),
    );
    designCheckoutStatusCache.invalidate(JSON.stringify([id, config.folder]));
    publish();
    if (config.type === "review")
      await prefetchReviewLiveData(provider, id, 42, { force: true });
  },
};
declare global {
  interface Window {
    workbenchStatusFixture: typeof fixture;
  }
}
window.workbenchStatusFixture = fixture;
fixture.render("files");
