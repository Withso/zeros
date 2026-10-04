// Real staff gate, shared controls and caches; all native I/O is synthetic.
import "../../../../../styles/zeros-tokens.css";
import "../../../../../styles/semantic-tokens.css";
import "../../../../../styles/globals.css";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { CloudWorkspaceAccessControls } from "../shell/conversation/cloud-workspace-access-controls";
import { setInternalFeatureEnabled } from "../features/settings/internal-features";
import { acceptOrganizationSnapshot } from "../features/team/team-store";
import { Button } from "../shared/ui";
import type { CloudWorkspaceDocument } from "../platform/cloud-workspaces";
import type { CloudServiceAccessRow } from "../platform/cloud-workspace-access";

const organizationId = "11111111-1111-4111-8111-111111111111";
const workspaceId = "22222222-2222-4222-8222-222222222222";
const context = {
  authorityId: "33333333-3333-4333-8333-333333333333",
  deviceId: "44444444-4444-4444-8444-444444444444",
  keyVersion: 1,
};
const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
let rows: CloudServiceAccessRow[] = [],
  nextId = 0;
let releaseRead: (() => void) | undefined;
Object.assign(window, {
  cloudNativeFixture: {
    calls,
    holdRead: false,
    releaseRead: () => releaseRead?.(),
  },
});
window.__ZEROS_NATIVE__ = {
  async invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
    calls.push({ command, args });
    if (command === "cloud_workspace_access_context")
      return { ...context } as T;
    if (command === "cloud_workspace_access_list") {
      if (
        (window as unknown as { cloudNativeFixture: { holdRead: boolean } })
          .cloudNativeFixture.holdRead
      )
        await new Promise<void>((resolve) => {
          releaseRead = resolve;
        });
      return rows.map((row) => ({ ...row })) as T;
    }
    if (command === "cloud_workspace_access_revoke") {
      rows = rows.filter((row) => row.accessId !== args?.accessId);
      return true as T;
    }
    if (
      [
        "cloud_workspace_ssh_copy",
        "cloud_workspace_ssh_terminal",
        "cloud_workspace_tunnel_start",
      ].includes(command)
    ) {
      const tunnel = command === "cloud_workspace_tunnel_start";
      const row: CloudServiceAccessRow = {
        accessId: `55555555-5555-4555-8555-${String(++nextId).padStart(12, "0")}`,
        kind: tunnel ? "tunnel" : "ssh",
        generation: 1,
        expiresAt: new Date(Date.now() + 900_000).toISOString(),
        localPort: tunnel ? Number(args?.localPort) : null,
        remotePort: tunnel ? Number(args?.remotePort) : null,
        closing: false,
      };
      rows = [...rows, row];
      return {
        accessId: row.accessId,
        expiresAt: row.expiresAt,
        ...(tunnel
          ? {
              localHost: "127.0.0.1",
              localPort: row.localPort,
              remotePort: row.remotePort,
            }
          : {}),
      } as T;
    }
    throw new Error("Unexpected native access fixture command.");
  },
  on: () => () => {},
};
acceptOrganizationSnapshot({
  user: {
    id: organizationId,
    email: "fixture@example.test",
    displayName: "Fixture",
    staffRole: "developer",
  },
  organizations: [],
  teams: [],
});
setInternalFeatureEnabled("cloudComputerV2", true);

const workspace: CloudWorkspaceDocument = {
  id: workspaceId,
  organizationId,
  teamId: organizationId,
  createdBy: organizationId,
  name: "Native access fixture",
  placement: "cloud",
  status: "ready",
  version: 1,
  error: null,
  createdAt: "2026-09-26T10:00:00Z",
  updatedAt: "2026-09-26T10:00:00Z",
  deletedAt: null,
  capabilities: {
    canEdit: true,
    canWrite: true,
    canManage: true,
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
};
function Harness() {
  const [active, setActive] = useState(true),
    [editor, setEditor] = useState(true);
  return (
    <main className="bg-bg0 text-fg1 min-h-screen p-6">
      <div className="mb-6 flex gap-2">
        <Button onClick={() => setActive((value) => !value)}>
          Toggle visibility
        </Button>
        <Button onClick={() => setEditor((value) => !value)}>
          Toggle edit access
        </Button>
        <Button
          onClick={() => setInternalFeatureEnabled("cloudComputerV2", false)}
        >
          Disable internal feature
        </Button>
      </div>
      <div className="bg-bg1 max-w-sm rounded-lg p-4">
        <h1 className="text-sm font-medium">Cloud workspace access</h1>
        <CloudWorkspaceAccessControls
          workspace={{
            ...workspace,
            capabilities: { ...workspace.capabilities, canEdit: editor },
          }}
          active={active}
        />
      </div>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<Harness />);
