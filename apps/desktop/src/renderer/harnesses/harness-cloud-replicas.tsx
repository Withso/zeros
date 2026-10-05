// Real details, controls, cache and native picker boundary; synthetic engine
// metadata only. No filesystem/provider operations or credentials are used.
import "../../../../../styles/zeros-tokens.css";
import "../../../../../styles/semantic-tokens.css";
import "../../../../../styles/globals.css";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { CloudWorkspaceDetails } from "../shell/conversation/cloud-workspace-details";
import { Button, TooltipProvider } from "../shared/ui/primitives";
import { acceptOrganizationSnapshot, clearTeamStore, getTeamStoreState } from "../features/team/team-store";
import { controlPlane, type StaffRole } from "../features/team/control-plane";
import { setInternalFeatureEnabled } from "../features/settings/internal-features";
import { setActiveBridge } from "../platform/bridge/active-bridge";
import type { RuntimeClient } from "../platform/bridge/ws-client";
import { cloudWorkspaceKey } from "../platform/bridge/cloud-workspace-key";
import type { CloudWorkspaceDocument } from "../platform/cloud-workspaces";
import type { CloudReplica } from "../platform/cloud-replicas";
import { acceptCloudWorkspaceDocument } from "../state/cloud-workspace-catalog";
import { cloudReplicaCache, cloudReplicaIdentityCache, clearCloudReplicaCaches } from "../state/cloud-replica-cache";
import { useWorkspaceStore } from "../state/workspace-store";

const organizationId = "11111111-1111-4111-8111-111111111111";
const workspaceA = "22222222-2222-4222-8222-222222222222";
const workspaceB = "33333333-3333-4333-8333-333333333333";
const accountA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const deviceA = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
let accountUserId = accountA, deviceId = deviceA;
let editAccess: boolean | undefined = true, offline = false;
let folderPath = "/Users/fixture/zeros-v2-test-sync";
let holdFolder = false, finishFolder: ((path: string | null) => void) | null = null;
const rows = new Map<string, CloudReplica>();
const changes = new Map<string, Array<{ path: string; detectedAt: number }>>();
const calls: Array<{ op: string; params: Record<string, unknown> }> = [];
const ownerKey = (params: Record<string, unknown>) => JSON.stringify([params.accountUserId, params.deviceId, params.organizationId, params.workspaceId]);
function installAccount(role: StaffRole | null = "developer") {
  acceptOrganizationSnapshot({ user: { id: accountUserId, email: "fixture@example.test", displayName: "Fixture", staffRole: role }, teams: [] });
}
function workspaceDocument(id: string): CloudWorkspaceDocument {
  return { id, organizationId, teamId: organizationId, ownerUserId: accountUserId, createdBy: accountUserId,
    name: id === workspaceA ? "First cloud workspace" : "Second cloud workspace", placement: "cloud", status: "ready", version: 1,
    createdAt: "2026-10-04T00:00:00Z", updatedAt: "2026-10-04T00:00:00Z", deletedAt: null, error: null,
    capabilities: { canWrite: true, canEdit: editAccess, canManage: true, canStart: true, startUnavailableReason: null },
    repository: { forge: "github.com", owner: "example", name: "fixture", revision: "main" },
    generation: { number: 1, architecture: "linux/amd64", observedState: "running", lastObservedAt: null,
      resources: { cpuMillicores: 2000, memoryMiB: 4096, storageMiB: 20480 } } };
}
function publishDocuments() { acceptCloudWorkspaceDocument(workspaceDocument(workspaceA)); acceptCloudWorkspaceDocument(workspaceDocument(workspaceB)); }
function invalidate() { cloudReplicaIdentityCache.invalidateAll(); cloudReplicaCache.invalidateAll(); }
window.__ZEROS_NATIVE__ = {
  async invoke<T>(command: string): Promise<T> {
    if (command === "dialog_pick_folder") {
      if (holdFolder) return await new Promise<string | null>(resolve => { finishFolder = resolve; }) as T;
      return folderPath as T;
    }
    return null as T;
  },
  on: () => () => {},
};
controlPlane.me = async () => getTeamStoreState().me!;
const bridge = {
  executionIdentity: { kind: "local", sidecar: "active" }, status: "connected",
  onStatusChange: () => () => {}, on: () => () => {},
  async request(message: { op: string; params: Record<string, unknown> }) {
    const { op, params } = message;
    if (!op.startsWith("cloudReplica.")) return { type: "WORKSPACE_RESPONSE", op, result: {} };
    calls.push({ op, params });
    if (params.accountUserId !== accountUserId || op !== "cloudReplica.identity" && params.deviceId !== deviceId)
      return { type: "WORKSPACE_ERROR", op, code: "identity_mismatch", message: "Fixture identity changed" };
    if (offline) throw new Error("Fixture offline");
    const key = ownerKey(params);
    let result: unknown;
    if (op === "cloudReplica.identity") result = { accountUserId, deviceId };
    else if (op === "cloudReplica.list") result = [...rows.values()].filter(row => row.accountUserId === accountUserId && row.deviceId === deviceId);
    else if (op === "cloudReplica.divergences") result = changes.get(key) ?? [];
    else {
      let row = rows.get(key);
      if (op === "cloudReplica.create") row = {
        accountUserId, deviceId, organizationId, workspaceId: String(params.workspaceId), replicaId: crypto.randomUUID(),
        rootPath: String(params.rootPath), desiredState: "active", observedState: "in_sync", manifestRevision: 1, eventCursor: 1,
        ignorePolicy: { version: 1, excludePrefixes: [] }, lastErrorCode: null,
      };
      if (!row) throw new Error("Fixture replica missing");
      if (op === "cloudReplica.pause") row = { ...row, desiredState: "paused", observedState: "paused" };
      if (op === "cloudReplica.remove") row = { ...row, desiredState: "removed", observedState: "removed" };
      if (op === "cloudReplica.resume") {
        if (params.replaceDiverged) changes.delete(key);
        row = { ...row, desiredState: "active", observedState: changes.get(key)?.length ? "diverged" : "in_sync" };
      }
      rows.set(key, row); result = row;
    }
    return { type: "WORKSPACE_RESPONSE", op, result };
  },
} as unknown as RuntimeClient;
setActiveBridge(bridge);
installAccount(); publishDocuments();
setInternalFeatureEnabled("cloudComputerV2", true);
useWorkspaceStore.setState({ activePage: "workspace" });

function Harness() {
  const [workspaceId, setWorkspaceId] = useState(workspaceA);
  Object.assign(window, { cloudReplicaHarness: {
    calls,
    folder: (path: string) => { folderPath = path; },
    holdFolder: () => { holdFolder = true; },
    finishFolder: (path: string | null) => { holdFolder = false; finishFolder?.(path); finishFolder = null; },
    hide: () => useWorkspaceStore.setState({ activePage: "dashboard" }),
    show: () => useWorkspaceStore.setState({ activePage: "workspace" }),
    offline: (value: boolean) => { offline = value; invalidate(); },
    staff: (value: boolean) => installAccount(value ? "developer" : null),
    canEdit: (value: boolean | undefined) => { editAccess = value; publishDocuments(); },
    device: (value: string) => { deviceId = value; invalidate(); },
    account: (value: string) => { clearTeamStore(); clearCloudReplicaCaches(); accountUserId = value; installAccount(); publishDocuments(); },
    diverge: () => {
      const key = ownerKey({ accountUserId, deviceId, organizationId, workspaceId }), row = rows.get(key);
      if (row) rows.set(key, { ...row, observedState: "diverged" });
      changes.set(key, [{ path: "src/zeros-v2-test-local.ts", detectedAt: 1 }]); cloudReplicaCache.invalidateAll();
    },
    detach: () => {
      const key = ownerKey({ accountUserId, deviceId, organizationId, workspaceId }), row = rows.get(key);
      if (row) rows.set(key, { ...row, observedState: "detached", lastErrorCode: "device_authority_revoked" });
      cloudReplicaCache.invalidateAll();
    },
  } });
  return <TooltipProvider>
    <main className="bg-bg0 text-fg1 min-h-screen p-6">
      <div className="mb-6 flex gap-2">
        <Button onClick={() => setWorkspaceId(workspaceA)}>First workspace</Button>
        <Button onClick={() => setWorkspaceId(workspaceB)}>Second workspace</Button>
      </div>
      <CloudWorkspaceDetails key={workspaceId} folder={cloudWorkspaceKey({ organizationId, workspaceId })} />
    </main>
  </TooltipProvider>;
}
createRoot(document.getElementById("root")!).render(<Harness />);
