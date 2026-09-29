import {
  closeCloudWorkspaceRuntime,
  openCloudWorkspaceRuntime,
  refreshCloudWorkspaceRuntime,
} from "../cloud-workspace-access";
import {
  acceptCloudEngineWorkspace,
  cloudCatalogGeneration,
  cloudWorkspaceDocument,
  canReadCloudWorkspace,
  refreshCloudWorkspace,
  subscribeCloudWorkspaces,
} from "../../state/cloud-workspace-catalog";
import type { CloudWorkspaceTarget } from "./cloud-workspace-key";
import { RuntimeClient } from "./ws-client";
import type { CloudPeer } from "./workspace-runtime-client";
import { bridgeWorkspaceList } from "./workspace-bridge";
import { cloudAgentGrant } from "../cloud-workspaces";
import { CloudAgentConnection } from "./cloud-agent-connection";
import { CloudEventReader } from "./cloud-event-reader";
import { installCloudGithubNative } from "./cloud-github-native";

export async function openCloudRuntime(
  target: CloudWorkspaceTarget,
  options?: { signal: AbortSignal },
): Promise<CloudPeer> {
  const generation = cloudCatalogGeneration();
  const assertAccount = () => {
    if (options?.signal.aborted) throw new Error("Cloud connection cancelled");
    if (generation !== cloudCatalogGeneration()) throw new Error("Cloud account changed while connecting");
  };
  assertAccount();
  const document = await refreshCloudWorkspace(target);
  assertAccount();
  if (!canReadCloudWorkspace(document) || !["ready", "busy"].includes(document.status))
    throw new Error(
      document.error?.message ??
        `Cloud workspace is ${document.status}. Wait for setup or start the workspace before connecting.`,
    );
  const assertCurrent = () => {
    assertAccount();
    const current = cloudWorkspaceDocument(target);
    if (!canReadCloudWorkspace(current) || current?.generation.number !== document.generation.number ||
        !["ready", "busy"].includes(current.status))
      throw new Error("Cloud workspace generation or availability changed while connecting");
  };
  assertCurrent();
  // The catalog is only a readiness hint. Every attachment mints a new
  // one-use, server-authorized admission; none is held in a renderer cache.
  const descriptor = await openCloudWorkspaceRuntime(target);
  try {
    assertCurrent();
    if (descriptor.organizationId !== target.organizationId || descriptor.workspaceId !== target.workspaceId ||
        descriptor.generation !== document.generation.number)
      throw new Error("Cloud workspace generation changed during admission");
  } catch (error) {
    void closeCloudWorkspaceRuntime(descriptor.runtimeId).catch(() => {});
    throw error;
  }
  const client = new RuntimeClient(descriptor, {
    refreshCloudConnectionTarget: refreshCloudWorkspaceRuntime,
  });
  let agents: CloudAgentConnection | undefined;
  let events: CloudEventReader | undefined;
  const listeners: Array<() => void> = [];
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    for (const off of listeners) off();
    events?.dispose();
    agents?.dispose();
    client.dispose();
    void closeCloudWorkspaceRuntime(descriptor.runtimeId).catch(() => {});
  };
  const checkConnection = () => {
    assertCurrent();
    if (released) throw new Error("Cloud connection cancelled");
  };
  options?.signal.addEventListener("abort", release, { once: true });
  listeners.push(() => options?.signal.removeEventListener("abort", release));
  listeners.push(subscribeCloudWorkspaces(() => {
    try { assertCurrent(); } catch { release(); }
  }));
  try {
    await client.connect();
    checkConnection();
    listeners.push(installCloudGithubNative(client, { ...target, generation: descriptor.generation }));
    const workspaces = await bridgeWorkspaceList(client, {});
    checkConnection();
    const workspace =
      workspaces.find((row) => row.id === target.workspaceId) ??
      workspaces.find((row) => row.id === "local-main");
    if (!workspace?.path || !workspace.path.startsWith("/"))
      throw new Error("Cloud engine did not confirm its workspace root");
    acceptCloudEngineWorkspace(target, workspace, generation);
    agents = new CloudAgentConnection(client, workspace.id, (agentId, model) =>
      cloudAgentGrant(target, agentId, model),
    );
    events = new CloudEventReader(client, () => {
      void agents!.refreshAttachments();
    });
    for (const type of ["AGENT_PROMPT_COMPLETE", "AGENT_PROMPT_FAILED"])
      listeners.push(events.on(type, message => {
        agents!.observePromptResult(message as unknown as Record<string, unknown>);
      }));
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
            checkConnection();
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
