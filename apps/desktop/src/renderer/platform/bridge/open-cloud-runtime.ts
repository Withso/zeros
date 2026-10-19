import {
  closeCloudWorkspaceRuntime,
  refreshCloudWorkspaceRuntime,
  publishCloudWorkspacePortForwardingRuntime,
} from "../cloud-workspace-access";
import { openCloudSdkWorkspaceRuntime, refreshCloudSdkWorkspaceRuntime, fallbackCloudSdkWorkspaceRuntime,
  signCloudSdkRuntimeProof, renewCloudSdkRuntimeCapabilities, activateCloudSdkRuntimeConnection, retireCloudSdkRuntimeConnection,
  prepareCloudSdkCommandEnvelope, cancelCloudSdkRuntimeCommand } from "../cloud-sdk-runtime";
import { subscribeCloudSdkRuntimeRenewals } from "../cloud-sdk-stream";
import { CloudSdkSocket, type CloudSdkSocketAuthority } from "./cloud-sdk-socket";
import { CloudRuntimeAccessError } from "./cloud-runtime-access-error";
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
import { wakeCloudWorkspace, type CloudWorkspaceWakeIntent } from "../../state/cloud-workspace-wake";

// Renderer IPC belongs at composition, so the same socket/handshake code can
// also run under the headless fixture's native authority without UI globals.
const sdkAuthority = (): CloudSdkSocketAuthority => ({
  signProof: signCloudSdkRuntimeProof, renewCapabilities: renewCloudSdkRuntimeCapabilities,
  activateConnection: activateCloudSdkRuntimeConnection, retireConnection: retireCloudSdkRuntimeConnection,
  prepareCommand: prepareCloudSdkCommandEnvelope, cancelCommand: cancelCloudSdkRuntimeCommand,
  subscribeRenewals: subscribeCloudSdkRuntimeRenewals,
});

export async function openCloudRuntime(
  target: CloudWorkspaceTarget,
  options?: { signal?: AbortSignal; wake?: boolean; reason?: "interaction"; wakeIntent?: CloudWorkspaceWakeIntent },
): Promise<CloudPeer> {
  const generation = cloudCatalogGeneration();
  const assertAccount = () => {
    if (options?.signal?.aborted) throw new Error("Cloud connection cancelled");
    if (generation !== cloudCatalogGeneration()) throw new Error("Cloud account changed while connecting");
  };
  assertAccount();
  let document = await refreshCloudWorkspace(target);
  assertAccount();
  if (options?.wake) {
    document = await wakeCloudWorkspace(target, document, options.signal, options.reason, options.wakeIntent);
    assertAccount();
  }
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
  // Native probes the exact cloud key. Only an explicit disabled/absent route
  // or old metadata selects the existing admission; denials never fall back.
  const descriptor = await openCloudSdkWorkspaceRuntime(target);
  try {
    assertCurrent();
    if (descriptor.organizationId !== target.organizationId || descriptor.workspaceId !== target.workspaceId ||
        descriptor.generation !== document.generation.number)
      throw new Error("Cloud workspace generation changed during admission");
  } catch (error) {
    void closeCloudWorkspaceRuntime(descriptor.runtimeId).catch(() => {});
    throw error;
  }
  let latestDescriptor = descriptor;
  let released = false;
  let wasReady = false;
  let legacyFlight: Promise<void> | undefined;
  const client = new RuntimeClient(descriptor, {
    refreshCloudConnectionTarget: async (previous) => {
      const next = previous.channel === "sdk-websocket" ? await refreshCloudSdkWorkspaceRuntime(previous) : await refreshCloudWorkspaceRuntime(previous);
      if (next.kind !== "cloud") throw new Error("Cloud runtime identity changed.");
      try { assertCurrent(); if (released) throw new Error("Cloud connection cancelled"); }
      catch (error) { void closeCloudWorkspaceRuntime(next.runtimeId).catch(() => {}); throw error; }
      latestDescriptor = next;
      return next;
    },
    createCloudSdkSocket: (previous, createSocket) => new CloudSdkSocket(previous, createSocket, () => {
      if (wasReady || released || previous.runtimeId !== latestDescriptor.runtimeId || previous.connectionSequence !== latestDescriptor.connectionSequence)
        return Promise.reject(new CloudRuntimeAccessError({ code: "cloud_workspace_sdk_legacy_required", status: 409 }));
      if (legacyFlight) return legacyFlight;
      legacyFlight = (async () => {
        const legacy = await fallbackCloudSdkWorkspaceRuntime(previous);
        try {
          assertCurrent(); if (released) throw new Error("Cloud connection cancelled");
          const boot = "bootScope" in legacy ? legacy.bootScope : undefined;
          if (legacy.organizationId !== previous.organizationId || legacy.workspaceId !== previous.workspaceId ||
              legacy.generation !== previous.generation || legacy.authorityEpoch !== previous.authorityEpoch ||
              legacy.engineInstanceId !== previous.engineInstanceId || !boot ||
              Object.entries(previous.bootScope).some(([key, value]) => boot[key as keyof typeof boot] !== value))
            throw new CloudRuntimeAccessError({ code: "cloud_workspace_access_superseded", status: 409 });
          latestDescriptor = legacy;
          await client.setConnectionTarget(legacy);
        } catch (error) { void closeCloudWorkspaceRuntime(legacy.runtimeId).catch(() => {}); throw error; }
      })();
      return legacyFlight;
    }, sdkAuthority()),
  });
  let agents: CloudAgentConnection | undefined;
  let events: CloudEventReader | undefined;
  const listeners: Array<() => void> = [];
  const release = () => {
    if (released) return;
    released = true;
    for (const off of listeners) off();
    events?.dispose();
    agents?.dispose();
    void publishCloudWorkspacePortForwardingRuntime(latestDescriptor, false).catch(() => {});
    client.dispose();
    void closeCloudWorkspaceRuntime(latestDescriptor.runtimeId).catch(() => {});
  };
  const checkConnection = () => {
    assertCurrent();
    if (released) throw new Error("Cloud connection cancelled");
  };
  options?.signal?.addEventListener("abort", release, { once: true });
  listeners.push(() => options?.signal?.removeEventListener("abort", release));
  listeners.push(subscribeCloudWorkspaces(() => {
    try { assertCurrent(); } catch { release(); }
  }));
  try {
    await client.connect();
    checkConnection();
    await client.waitUntilReady({ signal: options?.signal });
    checkConnection();
    wasReady = true;
    listeners.push(installCloudGithubNative(client, { ...target, generation: descriptor.generation }));
    const workspaces = await bridgeWorkspaceList(client, {});
    checkConnection();
    const workspace =
      workspaces.find((row) => row.id === target.workspaceId) ??
      workspaces.find((row) => row.id === "local-main");
    if (!workspace?.path || !workspace.path.startsWith("/"))
      throw new Error("Cloud engine did not confirm its workspace root");
    acceptCloudEngineWorkspace(target, workspace, generation);
    events = new CloudEventReader(client, conversationId => {
      void agents?.refreshAttachments(conversationId);
    });
    agents = new CloudAgentConnection(client, workspace.id, (agentId, model) =>
      cloudAgentGrant(target, agentId, model), events,
    );
    for (const type of ["AGENT_PROMPT_COMPLETE", "AGENT_PROMPT_FAILED"])
      listeners.push(events.on(type, message => {
        agents!.incoming(message as unknown as Record<string, unknown>);
        agents!.observePromptResult(message as unknown as Record<string, unknown>);
      }));
    for (const type of [
      "AGENT_SESSION_CREATED",
      "AGENT_SESSION_LOADED",
      "AGENT_SESSION_UPDATE",
    ])
      listeners.push(
        events.on(type, (message) => {
          agents!.incoming(message as unknown as Record<string, unknown>);
        }),
      );
    let refreshing = false;
    listeners.push(
      events.on("DB_CHANGED", () => {
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
        void publishCloudWorkspacePortForwardingRuntime(latestDescriptor, status === "connected").catch(() => {});
        if (status === "connected") void agents!.refreshAttachments();
      }),
    );
    void publishCloudWorkspacePortForwardingRuntime(latestDescriptor, client.status === "connected").catch(() => {});
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
      runtimeId: latestDescriptor.runtimeId,
      generation: descriptor.generation,
      async prepareForRun(signal, reason, wakeIntent) {
        const current = await refreshCloudWorkspace(target);
        assertAccount();
        await wakeCloudWorkspace(target, current, signal, reason, wakeIntent);
        if (signal.aborted) throw new Error("Cloud workspace open cancelled");
        // A committed capture retires this runtime while preparation waits.
        // A replacement generation does too. Preparation revalidated the
        // account/access/Stop intent; the caller now needs fresh admission.
        if (released) return false;
        assertCurrent();
        // Revalidate the still-live connection and root without a lifecycle
        // wake on ready compute. Reads do not clear the capture fence;
        // CloudAgentConnection waits on explicit checkpointing rejections.
        const rows = await bridgeWorkspaceList(client, {});
        if (signal.aborted) throw new Error("Cloud workspace open cancelled");
        checkConnection();
        if (!rows.some(row => row.id === workspace.id && row.path === workspace.path))
          throw new Error("Cloud workspace root changed while preparing to run");
        return true;
      },
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
