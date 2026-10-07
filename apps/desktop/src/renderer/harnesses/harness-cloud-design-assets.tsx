import "../../../../../styles/zeros-tokens.css";
import "../../../../../styles/semantic-tokens.css";
import "../../../../../styles/globals.css";
import "../features/design-workspace/design-workspace-ui.css";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { CloudDesignImageUpload } from "../features/design-workspace/cloud-design-image-upload";
import { useDesignWorkspaceUiStore } from "../features/design-workspace/state/design-workspace-ui";
import { acceptOrganizationSnapshot } from "../features/team/team-store";
import { cloudWorkspaceKey } from "../platform/bridge/cloud-workspace-key";
import { acceptCloudWorkspaceDocument } from "../state/cloud-workspace-catalog";
import type { CloudWorkspaceDocument } from "../platform/cloud-workspaces";
import type { RuntimeClient } from "../platform/bridge/ws-client";
import type { DesignCanvasFrameWire } from "../platform/bridge/design-bridge";
import { setActiveBridge } from "../platform/bridge/active-bridge";
import { Button, TooltipProvider } from "../shared/ui/primitives";
import { Toaster } from "../shared/ui/primitives/elements/toast";

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
    staffRole: null,
  },
  teams: [organization],
  organizations: [organization],
});
let version = 0;
function role(actorRole: "developer" | "prompter") {
  for (const id of ids)
    acceptCloudWorkspaceDocument({
      id,
      organizationId,
      teamId: organizationId,
      createdBy: organizationId,
      actorRole,
      name: "Design VM",
      placement: "cloud",
      status: "ready",
      version: ++version,
      error: null,
      createdAt: "2026-10-06T00:00:00Z",
      updatedAt: "2026-10-06T00:00:00Z",
      deletedAt: null,
      capabilities: {
        canWrite: true,
        canEdit: actorRole === "developer",
        canManage: false,
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
role("developer");
for (const key of keys)
  useDesignWorkspaceUiStore.getState().bindDirectory(key, "design_fixture");
const frame: DesignCanvasFrameWire = {
  file: "page-1/home.html",
  frameId: "frame_home",
  pageId: "page-1",
  title: "Home",
  sourceVersion: "a".repeat(24),
  width: 400,
  height: 300,
  x: 0,
  y: 0,
  z: 0,
  nodeCount: 1,
  modifiedAt: 0,
};
const requests: Array<{
  op: string;
  workspaceId: unknown;
  directoryId: unknown;
  frame: unknown;
  mimeType: unknown;
}> = [];
let hold = false;
let release: (() => void) | undefined;
let fail = false;
const read = File.prototype.arrayBuffer;
File.prototype.arrayBuffer = async function () {
  if (hold) {
    hold = false;
    await new Promise<void>((resolve) => {
      release = resolve;
    });
  }
  return read.call(this);
};
Object.assign(window, {
  cloudAssetFixture: {
    requests,
    hold: () => {
      hold = true;
    },
    get pending() {
      return !!release;
    },
    release: () => {
      release?.();
      release = undefined;
    },
    fail: () => {
      fail = true;
    },
  },
});
setActiveBridge({
  status: "connected",
  on: () => () => {},
  onStatusChange: () => () => {},
  request: async (message: { op: string; params: Record<string, unknown> }) => {
    const { op, params } = message;
    if (op !== "design.asset.upload")
      throw new Error("Unexpected upload operation");
    requests.push({
      op,
      workspaceId: params.workspaceId,
      directoryId: params.directoryId,
      frame: params.frame,
      mimeType: params.mimeType,
    });
    if (fail) {
      fail = false;
      throw new Error("Command failed: upload /srv/zeros/workspace/private-input; connection closed");
    }
    const next = { ...frame, sourceVersion: "b".repeat(24) };
    return {
      type: "WORKSPACE_RESPONSE",
      op,
      result: {
        mutation: {
          changed: true,
          frame: {
            ...next,
            source: "<main></main>",
            srcDoc: "<main></main>",
            tree: [],
          },
        },
        snapshot: {
          protocolCapability: null,
          directoryId: "design_fixture",
          directory: "Brand",
          frames: [next],
          pages: [
            {
              id: "page-1",
              title: "Page 1",
              folder: "page-1",
              frameFiles: [frame.file],
            },
          ],
          tokens: [],
          tokenSourceVersion: "a".repeat(24),
          assets: [],
          lint: {
            workspacePath: String(params.workspaceId),
            checkedFiles: [frame.file],
            violations: [],
            healedOids: 0,
          },
        },
      },
    };
  },
} as unknown as RuntimeClient);
function Harness() {
  const [owner, setOwner] = useState(0);
  const local = new URLSearchParams(location.search).has("local");
  return (
    <TooltipProvider>
      <Toaster />
      <main className="bg-bg1 text-fg1 min-h-screen p-6">
        <nav className="mb-4 flex gap-2">
          <Button onClick={() => role("developer")}>Developer</Button>
          <Button onClick={() => role("prompter")}>Prompter</Button>
          <Button onClick={() => setOwner(1 - owner)}>Other workspace</Button>
        </nav>
        <div
          role="toolbar"
          aria-label="Canvas tools"
          className="zd-design-floating-toolbar zd-canvas-toolbar"
        >
          <CloudDesignImageUpload
            workspaceId={local ? "ws_local" : keys[owner]}
            directoryId="design_fixture"
            frame={frame}
            active
          />
        </div>
      </main>
    </TooltipProvider>
  );
}
createRoot(document.getElementById("root")!).render(<Harness />);
