// Real directory settings and canvas menu; synthetic cloud transport only.
import "../../../../../styles/zeros-tokens.css";
import "../../../../../styles/semantic-tokens.css";
import "../../../../../styles/globals.css";
import "../features/design-workspace/design-workspace-ui.css";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { DesignSection } from "../features/repositories/design-section";
import { DesignDirectoryMenu } from "../features/design-workspace/design-directory-menu";
import { acceptOrganizationSnapshot } from "../features/team/team-store";
import { setInternalFeatureEnabled } from "../features/settings/internal-features";
import { cloudWorkspaceKey } from "../platform/bridge/cloud-workspace-key";
import {
  acceptCloudWorkspaceDocument,
  cloudProjectForFolder,
  getCloudWorkspaceRows,
} from "../state/cloud-workspace-catalog";
import type {
  CloudWorkspaceDocument,
  CloudWorkspaceActorRole,
} from "../platform/cloud-workspaces";
import { setActiveBridge } from "../platform/bridge/active-bridge";
import type { RuntimeClient } from "../platform/bridge/ws-client";
import { Button, TooltipProvider } from "../shared/ui/primitives";
import { Toaster } from "../shared/ui/primitives/elements/toast";
import { cloudDesignFolderCache } from "../state/read-caches";
import type { Workspace } from "../platform/git";

const local = new URLSearchParams(location.search).has("local");
const organizationId = "11111111-1111-4111-8111-111111111111";
const ids = [
  "22222222-2222-4222-8222-222222222222",
  "33333333-3333-4333-8333-333333333333",
];
const keys = ids.map((workspaceId) =>
  cloudWorkspaceKey({ organizationId, workspaceId }),
);
const organization = {
  id: organizationId,
  slug: "fixture",
  name: "Example",
  logo: null,
  isPersonal: false,
  role: "admin" as const,
  defaultTeamId: organizationId,
  workspaceCapabilities: { local: false, cloud: true },
  teamCapabilities: { multiple: false as const, canCreate: false as const },
};
acceptOrganizationSnapshot({
  user: {
    id: organizationId,
    email: "fixture@example.test",
    displayName: "Fixture",
    staffRole: "developer",
  },
  teams: [organization],
  organizations: [organization],
});
setInternalFeatureEnabled("cloudComputerV2", true);
let version = 0;
function role(actorRole: CloudWorkspaceActorRole) {
  for (const id of ids)
    acceptCloudWorkspaceDocument({
      id,
      organizationId,
      teamId: organizationId,
      createdBy: organizationId,
      actorRole,
      name: id === ids[0] ? "Design VM A" : "Design VM B",
      placement: "cloud",
      status: "ready",
      version: ++version,
      error: null,
      createdAt: "2026-10-06T00:00:00Z",
      updatedAt: "2026-10-06T00:00:00Z",
      deletedAt: null,
      capabilities: {
        canWrite: true,
        canEdit: actorRole !== "prompter",
        canManage: actorRole === "manager",
        canStart: true,
        startUnavailableReason: null,
      },
      repository: {
        forge: "github.com",
        owner: "example",
        name: "project",
        revision: "refs/heads/main",
      },
      generation: {
        number: 1,
        architecture: "x86_64",
        resources: { cpuMillicores: 2000, memoryMiB: 4096, storageMiB: 20480 },
        observedState: "running",
        lastObservedAt: null,
      },
    } satisfies CloudWorkspaceDocument);
}
role("manager");
const states = new Map(
  [...keys, "ws_local"].map((key) => [
    key,
    {
      directories: { Brand: "design_brand", Other: "design_other" } as Record<
        string,
        string
      >,
      active: "Brand",
    },
  ]),
);
const requests: Array<{ op: string; params: Record<string, unknown> }> = [];
let release: (() => void) | undefined;
let holdNextBrowse = false;
let failNextCreate = false;
window.__ZEROS_NATIVE__ = {
  invoke: async () => {
    throw new Error("Native picker must never be called");
  },
  on: () => () => {},
};
Object.assign(window, {
  cloudDesignFixture: {
    requests,
    failNextCreate: () => { failNextCreate = true; },
    get pending() {
      return !!release;
    },
    holdNextBrowse: () => {
      holdNextBrowse = true;
      cloudDesignFolderCache.invalidateAll();
    },
    release: () => {
      release?.();
      release = undefined;
    },
  },
});
setActiveBridge({
  status: "connected",
  on: () => () => {},
  onStatusChange: () => () => {},
  request: async (message: { op: string; params: Record<string, unknown> }) => {
    const { op, params } = message;
    requests.push({ op, params });
    if (op === "design.createDirectory" && failNextCreate) {
      failNextCreate = false;
      throw new Error("Command failed: git --git-dir=/srv/zeros/workspace/.git --work-tree=/tmp/zeros-design-ignore-fixture check-ignore: fatal: this operation must be run in a work tree");
    }
    if (local && op === "settings.write")
      return { type: "WORKSPACE_RESPONSE", op, result: { ok: true } };
    const state = states.get(String(params.workspaceId));
    if (!state) throw new Error("Request escaped its cloud workspace");
    let result: unknown = {};
    if (op === "settings.write" || op === "fs.listDir")
      throw new Error("Unexpected generic host operation");
    if (op === "design.listDirectories")
      result = {
        directories: Object.keys(state.directories),
        directoryIds: state.directories,
        active: state.active,
        pointer: state.active,
        target: { directory: state.active, exists: true },
      };
    if (op === "design.selectDirectory") {
      if (params.expectedDirectoryId !== state.directories[state.active])
        throw new Error("Stale selection");
      state.active = Object.keys(state.directories).find(
        (key) => state.directories[key] === params.directoryId,
      )!;
    }
    if (op === "design.createDirectory")
      state.directories[String(params.directory)] =
        `design_created_${version++}`;
    if (op === "design.browseDirectories") {
      if (holdNextBrowse) {
        holdNextBrowse = false;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      const directory = String(params.directory);
      result = {
        directory,
        directories:
          directory === ""
            ? ["Assets", "Empty"]
            : directory === "Assets"
              ? ["Assets/Screens"]
              : [],
        truncated: false,
      };
    }
    if (op === "design.previewExistingDirectory")
      result = {
        directory: params.folder,
        revision: "fixture-revision",
        metadataSource: "rebuild",
        frameCount: 2,
      };
    if (op === "design.adoptDirectory")
      state.directories[String(params.folder)] = "design_adopted";
    if (op === "design.renameDirectory") {
      state.directories[String(params.to)] =
        state.directories[String(params.from)];
      delete state.directories[String(params.from)];
      if (state.active === params.from) state.active = String(params.to);
    }
    if (op === "design.removeDirectory")
      delete state.directories[String(params.directory)];
    return { type: "WORKSPACE_RESPONSE", op, result };
  },
} as unknown as RuntimeClient);

function Harness() {
  const [owner, setOwner] = useState(0);
  const [active, setActive] = useState(true);
  const key = local ? "ws_local" : keys[owner];
  const workspace = local
    ? { ...getCloudWorkspaceRows()[0], id: key, path: "/repo", repoRoot: "/repo", placement: "local" } as Workspace
    : getCloudWorkspaceRows().find((row) => row.id === key)!;
  return (
    <TooltipProvider>
      <Toaster />
      <main className="bg-bg1 text-fg1 min-h-screen p-6">
        <nav className="mb-4 flex gap-2" aria-label="Fixture controls">
          <Button onClick={() => role("manager")}>Manager</Button>
          <Button onClick={() => role("developer")}>Developer</Button>
          <Button onClick={() => role("prompter")}>Prompter</Button>
          <Button onClick={() => setOwner(1 - owner)}>Other workspace</Button>
          <Button onClick={() => setActive(!active)}>Toggle active</Button>
        </nav>
        <DesignDirectoryMenu
          key={`menu:${key}`}
          workspace={workspace}
          name="Brand"
          active={active}
        />
        {!local && <section
          className="mt-4 max-w-2xl"
          aria-label="Repository Design settings"
        >
          <DesignSection
            project={cloudProjectForFolder(key)!}
            surfaceActive={active}
          />
        </section>}
      </main>
    </TooltipProvider>
  );
}
createRoot(document.getElementById("root")!).render(<Harness />);
