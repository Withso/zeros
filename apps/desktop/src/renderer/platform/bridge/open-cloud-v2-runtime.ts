// Opens a cloud v2 workspace for the shared runtime client: one control-plane
// relay socket to the workspace worker, authenticated by a short-lived ticket.
// The worker answers the same bridge frames as a Local engine, so the shared
// UI needs no cloud-only agent, history or event layer.
import type { CloudV2ConnectionTarget } from "@zeros/protocol/cloud-runtime-connection";
import { connectCloudV2Workspace } from "../cloud-v2";
import { acceptCloudEngineWorkspace, cloudCatalogGeneration, cloudWorkspaceDocument } from "../../state/cloud-workspace-catalog";
import type { CloudWorkspaceTarget } from "./cloud-workspace-key";
import { RuntimeClient } from "./ws-client";
import type { CloudPeer } from "./workspace-runtime-client";
import { bridgeWorkspaceList } from "./workspace-bridge";

const CONNECT_TIMEOUT_MS = 3 * 60_000;

async function ticketTarget(target: CloudWorkspaceTarget, sequence: number): Promise<CloudV2ConnectionTarget> {
  const ticket = await connectCloudV2Workspace(target);
  return {
    kind: "cloud",
    channel: "v2-websocket",
    // The workspace is its own runtime identity in v2; there are no generations.
    runtimeId: target.workspaceId,
    organizationId: target.organizationId,
    workspaceId: target.workspaceId,
    generation: 1,
    authorityEpoch: 1,
    engineInstanceId: target.workspaceId,
    connectionSequence: sequence,
    url: ticket.url,
    protocols: ticket.protocols,
    expiresAt: Date.parse(ticket.expiresAt),
  };
}

function connected(client: RuntimeClient, signal?: AbortSignal): Promise<void> {
  if (client.status === "connected") return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { off(); reject(new Error("The cloud workspace did not start in time")); }, CONNECT_TIMEOUT_MS);
    const abort = () => { off(); reject(new Error("Cloud connection cancelled")); };
    const off = client.onStatusChange(status => {
      if (status !== "connected") return;
      clearTimeout(timer); signal?.removeEventListener("abort", abort); off(); resolve();
    });
    signal?.addEventListener("abort", abort, { once: true });
  });
}

/** Connecting starts a stopped VM, so only an explicit open may do that.
 * Passive warm-ups (hover, a retained tab) leave it stopped; its history is
 * read from the control plane meanwhile. */
export async function openCloudV2Runtime(
  target: CloudWorkspaceTarget,
  options?: { signal?: AbortSignal; wake?: boolean },
): Promise<CloudPeer> {
  if (!options?.wake && ["stopped", "failed"].includes(cloudWorkspaceDocument(target)?.status ?? ""))
    throw new Error("The cloud workspace is stopped");
  const account = cloudCatalogGeneration();
  const assertAccount = () => {
    if (options?.signal?.aborted) throw new Error("Cloud connection cancelled");
    if (account !== cloudCatalogGeneration()) throw new Error("Cloud account changed while connecting");
  };
  let sequence = 1;
  const client = new RuntimeClient(await ticketTarget(target, sequence), {
    // Each reconnect presents a fresh ticket; the relay wakes a stopped VM.
    refreshCloudConnectionTarget: async () => {
      assertAccount();
      return ticketTarget(target, ++sequence);
    },
  });
  try {
    assertAccount();
    void client.connect();
    await connected(client, options?.signal);
    assertAccount();
    const workspace = (await bridgeWorkspaceList(client, {})).find(row => row.id === target.workspaceId);
    if (!workspace?.path || !workspace.path.startsWith("/"))
      throw new Error("Cloud workspace did not confirm its checkout");
    acceptCloudEngineWorkspace(target, workspace, account);
    return {
      client,
      scope: { ...target, root: workspace.path, engineWorkspaceId: workspace.id },
      runtimeId: target.workspaceId,
      generation: 1,
      release: () => client.dispose(),
    };
  } catch (error) {
    client.dispose();
    throw error;
  }
}
