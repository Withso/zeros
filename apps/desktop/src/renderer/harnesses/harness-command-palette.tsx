// Real palette, navigation, catalogs and shared file cache; only I/O is synthetic.
import "../../../../../styles/zeros-tokens.css";
import "../../../../../styles/semantic-tokens.css";
import "../../../../../styles/globals.css";
import { useCallback, useState } from "react";
import { createRoot } from "react-dom/client";
import type { Workspace } from "../platform/git";
import type { RuntimeClient } from "../platform/bridge/ws-client";
import type { SessionsActions } from "../features/agent/sessions-context";
import type { AuthContextValue } from "../features/auth/auth-context";
import type { CloudWorkspaceDocument } from "../platform/cloud-workspaces";

localStorage.clear();
const organizationA = "11111111-1111-4111-8111-111111111111";
const organizationB = "44444444-4444-4444-8444-444444444444";
const account = "55555555-5555-4555-8555-555555555555";
const cloudId = "22222222-2222-4222-8222-222222222222";
const cloudPath = `cloud://${organizationA}/${cloudId}`;
const rows: Workspace[] = [
  ["alpha", null],
  ["bravo", null],
  ["archive", null],
  ["org-local", organizationA],
  ["other-owner", organizationB],
].map(([name, owner], index) => ({
  id: name!,
  path: `/fixture/workspaces/${name}`,
  repoRoot: "/fixture/project",
  repoSlug: "example/app",
  branch: `zeros/${name}`,
  baseBranch: "main",
  status: "in-progress",
  createdAt: 1,
  archivedAt: name === "archive" ? 100 : null,
  stashRef: null,
  prNumber: name === "alpha" ? 42 : null,
  prState: null,
  prUrl: null,
  agentId: null,
  lastActiveAt: 1000 - index,
  organizationId: owner,
  placement: "local",
}));
rows.push(
  ...Array.from({ length: 180 }, (_, i) => ({
    ...rows[0],
    id: `extra-${i}`,
    path: `/fixture/workspaces/extra-${i}`,
    branch: `zeros/extra-${i}`,
    lastActiveAt: i,
  })),
);
localStorage.setItem(
  "zeros-projects-v1",
  JSON.stringify([
    {
      id: "app",
      name: "Example app",
      repoRoot: "/fixture/project",
      repoSlug: "example/app",
      originUrl: "https://github.com/example/app.git",
      isGitRepository: true,
      addedAt: 1,
    },
  ]),
);

const requests: { op: string; params?: Record<string, unknown> }[] = [];
let cloudRows: readonly Workspace[] = [];
const held = new Set<string>();
const failed = new Set<string>();
const releases = new Map<string, (() => void)[]>();
const fileNames = (folder: string) =>
  folder.endsWith("alpha")
    ? [
        "src/app.tsx",
        "src/styles.css",
        "docs/README.md",
        " space name .ts",
        "same.ts",
        "same.ts ",
        ...Array.from(
          { length: 1200 },
          (_, i) => `src/generated/component-${i}.tsx`,
        ),
      ]
    : [`${folder.endsWith("bravo") ? "bravo" : "owner"}-only.ts`];
async function listing(folder: string) {
  const files = fileNames(folder);
  if (held.has(folder))
    await new Promise<void>((resolve) =>
      releases.set(folder, [...(releases.get(folder) ?? []), resolve]),
    );
  if (failed.has(folder)) throw new Error("Fixture file read unavailable");
  return { files };
}
Object.assign(window, {
  __ZEROS_NATIVE__: {
    on: () => () => {},
    invoke: async (op: string, params?: Record<string, unknown>) => {
      requests.push({ op, params });
      if (op === "app_info")
        return {
          runtimeMode: "dev",
          channel: "alpha",
          version: "0.1.0",
          platform: "darwin",
          arch: "arm64",
        };
      if (op === "git_list_files") return listing(String(params?.cwd));
      return null;
    },
  },
});
const { setActiveBridge } = await import("../platform/bridge/active-bridge");
setActiveBridge({
  executionIdentity: { kind: "local", sidecar: "active" },
  status: "connected",
  onStatusChange: () => () => {},
  onMessage: () => () => {},
  on: () => () => {},
  request: async (message: {
    op: string;
    params?: Record<string, unknown>;
  }) => {
    requests.push(message);
    let result: unknown = {};
    if (message.op === "workspace.list")
      result = {
        workspaces: [...rows, ...cloudRows].filter(
          (row) =>
            !!row.archivedAt === (message.params?.archived === true) &&
            (!message.params?.repoSlug ||
              row.repoSlug === message.params.repoSlug),
        ),
      };
    if (message.op === "file.tree") {
      const workspace = rows.find(
        (row) => row.id === message.params?.workspaceId,
      );
      result = await listing(
        workspace?.path ?? String(message.params?.workspaceId),
      );
    }
    if (message.op === "settings.resolve")
      result = { effective: {}, sources: {}, warnings: [] };
    if (message.op === "settings.read")
      result = { doc: {}, text: "", exists: false };
    return { type: "response", result };
  },
} as unknown as RuntimeClient);

const { useWorkspaceStore, selectActiveFolder, workbenchScopeForFolder } =
  await import("../state/workspace-store");
const { setWorkspaceRowsForTesting, notifyProjectsChanged } =
  await import("../state/use-projects");
const { acceptOrganizationSnapshot } =
  await import("../features/team/team-store");
const { setActiveOrganizationSelection } =
  await import("../features/team/active-team");
const { PERSONAL_ORGANIZATION } =
  await import("../features/team/personal-organization");
const { controlPlane } = await import("../features/team/control-plane");
const {
  acceptCloudWorkspaceDocument,
  getCloudProjects,
  getCloudWorkspaceRows,
} = await import("../state/cloud-workspace-catalog");
const { triggerGitRefresh } = await import("../shell/use-git-refresh-key");
const { invalidateWorkspaceFiles } =
  await import("../shell/workspace-files-cache");
const { ActionsCtx } = await import("../features/agent/sessions-context");
const { AuthContext } = await import("../features/auth/auth-context");
const { AddProjectProvider } = await import("../shell/add-project-provider");
const { CommandPaletteController } =
  await import("../shell/command-palette-controller");
const { ShortcutsPalette } = await import("../shell/shortcuts-palette");
const { useCommandPaletteHotkey } =
  await import("../shell/use-command-palette-hotkey");
const { useShortcutsHotkey } = await import("../shell/use-shortcuts-hotkey");
const { Button, Input, TooltipProvider, Toaster } =
  await import("../shared/ui/primitives");

const organizations = [organizationA, organizationB].map((id, index) => ({
  ...PERSONAL_ORGANIZATION,
  id,
  name: `Organization ${index + 1}`,
  isPersonal: false,
  workspaceCapabilities: { local: true, cloud: true },
}));
const me = {
  user: {
    id: account,
    email: "fixture@example.test",
    displayName: "Fixture",
    staffRole: null,
  },
  organizations,
  teams: organizations,
};
controlPlane.me = async () => me;
acceptOrganizationSnapshot(me);
const cloudDocument: CloudWorkspaceDocument = {
  id: cloudId,
  organizationId: organizationA,
  teamId: organizationA,
  createdBy: account,
  name: "cloud-alpha",
  placement: "cloud",
  status: "stopped",
  version: 1,
  error: null,
  createdAt: "2026-10-23T00:00:00Z",
  updatedAt: "2026-10-23T00:00:00Z",
  deletedAt: null,
  capabilities: {
    canWrite: true,
    canEdit: true,
    canManage: true,
    canStart: true,
    startUnavailableReason: null,
  },
  repository: {
    forge: "github.com",
    owner: "example",
    name: "cloud-app",
    revision: "refs/heads/main",
  },
  generation: {
    number: 1,
    architecture: "x86_64",
    resources: { cpuMillicores: 2000, memoryMiB: 4096, storageMiB: 20480 },
    observedState: "stopped",
    lastObservedAt: null,
  },
};
const syncCloud = () => {
  acceptCloudWorkspaceDocument(cloudDocument);
  cloudRows = getCloudWorkspaceRows();
  for (const project of getCloudProjects())
    setWorkspaceRowsForTesting(
      project.repoSlug,
      getCloudWorkspaceRows().filter(
        (row) => row.repoSlug === project.repoSlug,
      ),
    );
  notifyProjectsChanged();
};
syncCloud();
setWorkspaceRowsForTesting(
  "example/app",
  rows.filter((row) => !row.archivedAt),
);
const chatRows = [...rows.slice(0, 5), ...getCloudWorkspaceRows()].map(
  (row, i) => ({
    id: `chat-${row.id}`,
    folder: row.path,
    title: `${row.branch.replace("zeros/", "")} conversation`,
    agentId: null,
    agentName: null,
    model: null,
    effort: "medium" as const,
    permissionMode: "auto" as const,
    createdAt: Date.now(),
    updatedAt: Date.now() - i * 86_400_000,
  }),
);
useWorkspaceStore.setState({
  chats: chatRows,
  activeChatId: "chat-alpha",
  activePage: "workspace",
  lastWorkspaceFolder: rows[0].path,
});
const sessions = {
  hydrateChat: async () => {},
  listAgents: async () => [],
  getSession: () => undefined,
} as unknown as SessionsActions;
const auth = {
  status: "authenticated",
  session: null,
  userId: account,
  email: me.user.email,
} as AuthContextValue;
let reveals = 0;

Object.assign(window, {
  paletteFixture: {
    organizationA,
    organizationB,
    cloudPath,
    requests,
    owner: (id: string | null) =>
      setActiveOrganizationSelection(id, id === null),
    navigate: (id: string) => {
      const row = [...rows, ...getCloudWorkspaceRows()].find(
        (workspace) => workspace.id === id || workspace.path === id,
      )!;
      useWorkspaceStore
        .getState()
        .dispatch({
          type: "OPEN_WORKSPACE",
          folder: row.path,
          repoRoot: row.repoRoot,
          chatId: `chat-${row.id}`,
        });
    },
    cloudStatus: (status: CloudWorkspaceDocument["status"]) => {
      cloudDocument.status = status;
      syncCloud();
    },
    hold: (folder: string) => {
      held.add(folder);
      invalidateWorkspaceFiles(folder);
    },
    release: (folder: string) => {
      held.delete(folder);
      for (const release of releases.get(folder) ?? []) release();
      releases.delete(folder);
    },
    fail: (folder: string, value: boolean) => {
      if (value) failed.add(folder);
      else failed.delete(folder);
      triggerGitRefresh(folder);
    },
    refresh: (folder: string) => triggerGitRefresh(folder),
    state: () => {
      const state = useWorkspaceStore.getState();
      const folder = selectActiveFolder(state);
      return {
        page: state.activePage,
        folder,
        chatId: state.activeChatId,
        chats: state.chats.length,
        workbench: state.workbenchByScope[workbenchScopeForFolder(folder)],
        reveals,
        settings: localStorage.getItem("zeros:settings"),
      };
    },
  },
});

function Harness() {
  const [palette, setPalette] = useState<"commands" | "shortcuts" | null>(null);
  const toggleCommands = useCallback(
    () => setPalette((value) => (value === "commands" ? null : "commands")),
    [],
  );
  const toggleShortcuts = useCallback(
    () => setPalette((value) => (value === "shortcuts" ? null : "shortcuts")),
    [],
  );
  useCommandPaletteHotkey(toggleCommands);
  useShortcutsHotkey(toggleShortcuts);
  const page = useWorkspaceStore((state) => state.activePage);
  return (
    <div className="bg-bg1 text-fg1 fixed inset-0 p-6 font-sans text-sm">
      <Toaster />
      <div className="flex items-center gap-2">
        <Button onClick={toggleCommands}>Open commands</Button>
        <Input aria-label="Composer" placeholder="Write a message…" />
      </div>
      <p className="text-fg2 py-4">Workspace · {page}</p>
      {palette === "commands" && (
        <CommandPaletteController
          onDismiss={() =>
            setPalette((value) => (value === "commands" ? null : value))
          }
          onShowShortcuts={() => setPalette("shortcuts")}
          revealWorkbench={() => {
            reveals++;
          }}
          toggleWorkbench={() => {
            reveals++;
          }}
        />
      )}
      <ShortcutsPalette
        open={palette === "shortcuts"}
        onOpenChange={(open) =>
          setPalette((value) =>
            open ? "shortcuts" : value === "shortcuts" ? null : value,
          )
        }
      />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <AuthContext.Provider value={auth}>
    <ActionsCtx.Provider value={sessions}>
      <TooltipProvider>
        <AddProjectProvider>
          <Harness />
        </AddProjectProvider>
      </TooltipProvider>
    </ActionsCtx.Provider>
  </AuthContext.Provider>,
);
