import {
  closeCloudWorkspaceRuntime,
  openCloudWorkspaceRuntime,
  refreshCloudWorkspaceRuntime,
} from "../cloud-workspace-access";
import {
  acceptCloudEngineWorkspace,
  cloudCatalogGeneration,
  refreshCloudWorkspace,
} from "../../state/cloud-workspace-catalog";
import type { CloudWorkspaceTarget } from "./cloud-workspace-key";
import { RuntimeClient } from "./ws-client";
import type { CloudPeer } from "./workspace-runtime-client";
import { bridgeWorkspaceList } from "./workspace-bridge";
import { cloudAgentGrant } from "../cloud-workspaces";
import { CloudAgentConnection } from "./cloud-agent-connection";
import { CloudEventReader } from "./cloud-event-reader";

export async function openCloudRuntime(
  target: CloudWorkspaceTarget,
): Promise<CloudPeer> {
  const generation = cloudCatalogGeneration();
  const document = await refreshCloudWorkspace(target);
  if (!["ready", "busy"].includes(document.status))
    throw new Error(
      document.error?.message ??
        `Cloud workspace is ${document.status}. Wait for setup or start the workspace before connecting.`,
    );
  const descriptor = await openCloudWorkspaceRuntime(target);
  const client = new RuntimeClient(descriptor, {
    refreshCloudConnectionTarget: refreshCloudWorkspaceRuntime,
  });
  let agents: CloudAgentConnection | undefined;
  let events: CloudEventReader | undefined;
  const listeners: Array<() => void> = [];
  const release = () => {
    for (const off of listeners) off();
    events?.dispose();
    agents?.dispose();
    client.dispose();
    void closeCloudWorkspaceRuntime(descriptor.runtimeId).catch(() => {});
  };
  try {
    await client.connect();
    const workspaces = await bridgeWorkspaceList(client, {});
    const workspace =
      workspaces.find((row) => row.id === target.workspaceId) ??
      workspaces.find((row) => row.id === "local-main");
    if (!workspace?.path || !workspace.path.startsWith("/"))
      throw new Error("Cloud engine did not confirm its workspace root");
    if (generation !== cloudCatalogGeneration())
      throw new Error("Cloud account changed while connecting");
    acceptCloudEngineWorkspace(target, workspace, generation);
    agents = new CloudAgentConnection(client, workspace.id, (agentId, model) =>
      cloudAgentGrant(target, agentId, model),
    );
    events = new CloudEventReader(client, () => {
      void agents!.refreshAttachments();
    });
    for (const type of [
      "AGENT_SESSION_CREATED",
      "AGENT_SESSION_LOADED",
      "AGENT_SESSION_UPDATE",
    ])
      listeners.push(
        client.on(type, (message) => {
          agents!.incoming(message as unknown as Record<string, unknown>);
        }),
      );
    let refreshing = false;
    listeners.push(
      client.on("DB_CHANGED", () => {
        if (refreshing) return;
        refreshing = true;
        void bridgeWorkspaceList(client, {})
          .then((rows) => {
            const next = rows.find((row) => row.id === workspace.id);
            if (next) acceptCloudEngineWorkspace(target, next, generation);
          })
          .catch(() => {})
          .finally(() => {
            refreshing = false;
          });
      }),
    );
    listeners.push(
      client.onStatusChange((status) => {
        if (status === "connected") void agents!.refreshAttachments();
      }),
    );
    const reader = events;
    const adapter = agents;
    return {
      client,
      agents,
      events: {
        on(type, listener) {
          const offReplay = reader.on(type, listener);
          const offControls = adapter.on(type, listener);
          return () => {
            offReplay();
            offControls();
          };
        },
      },
      runtimeId: descriptor.runtimeId,
      scope: {
        ...target,
        root: workspace.path,
        engineWorkspaceId: workspace.id,
      },
      release,
    };
  } catch (error) {
    release();
    throw error;
  }
}
