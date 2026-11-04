// Opens a cloud v2 workspace for the shared runtime client: one control-plane
// relay socket to the workspace worker, authenticated by a short-lived ticket.
// The worker answers the same bridge frames as a Local engine, so the shared
// UI needs no cloud-only agent, history or event layer.
import type { CloudV2ConnectionTarget } from "@zeros/protocol/cloud-runtime-connection";
import { connectCloudV2Workspace } from "../cloud-v2";
import { ControlPlaneError } from "../../features/team/control-plane";
import {
  acceptCloudEngineWorkspace, cloudCatalogGeneration, cloudWorkspaceDocument,
  cloudWorkspaceOwnerGeneration, cloudWorkspaceStopVersion, subscribeCloudWorkspaces,
} from "../../state/cloud-workspace-catalog";
import { canOpenCloudWorkspace } from "../../state/cloud-workspace-wake";
import type { CloudWorkspaceTarget } from "./cloud-workspace-key";
import { RuntimeClient } from "./ws-client";
import type { CloudPeer } from "./workspace-runtime-client";
import { bridgeWorkspaceList } from "./workspace-bridge";

const CONNECT_TIMEOUT_MS = 3 * 60_000;
const TICKET_TIMEOUT_MS = 30_000;
const TICKET_BACKOFF_MS = [250, 500, 1_000, 2_000];

function connectionWait(assertCurrent: () => void, deadline: number, signal?: AbortSignal) {
  const controller = new AbortController();
  const timeout = () => controller.abort(new Error("The cloud workspace did not start in time"));
  const abort = () => controller.abort(new Error("Cloud connection cancelled"));
  const check = () => {
    controller.signal.throwIfAborted();
    assertCurrent();
    if (performance.now() >= deadline) { timeout(); controller.signal.throwIfAborted(); }
  };
  const off = subscribeCloudWorkspaces(() => {
    try { check(); } catch (error) { controller.abort(error); }
  });
  const timer = setTimeout(timeout, Math.max(0, deadline - performance.now()));
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  return {
    signal: controller.signal, check,
    // Fetch/bridge implementations need not settle when their signal aborts.
    wait: <T>(promise: Promise<T>): Promise<T> => new Promise((resolve, reject) => {
      const clean = () => controller.signal.removeEventListener("abort", cancelled);
      const cancelled = () => { clean(); reject(controller.signal.reason); };
      controller.signal.addEventListener("abort", cancelled, { once: true });
      promise.then(value => { clean(); resolve(value); }, error => { clean(); reject(error); });
      if (controller.signal.aborted) cancelled();
    }),
    dispose: () => { clearTimeout(timer); off(); signal?.removeEventListener("abort", abort); },
  };
}

function transientTicketFailure(error: unknown): boolean {
  if (error instanceof ControlPlaneError) return error.status >= 500 && error.status < 600;
  return error instanceof TypeError || error instanceof DOMException && ["NetworkError", "TimeoutError"].includes(error.name);
}

async function ticketTarget(
  target: CloudWorkspaceTarget, sequence: number, wake: boolean,
  assertCurrent: () => void, deadline: number, signal?: AbortSignal,
): Promise<CloudV2ConnectionTarget> {
  const waiting = connectionWait(assertCurrent, Math.min(deadline, performance.now() + TICKET_TIMEOUT_MS), signal);
  let ticket: Awaited<ReturnType<typeof connectCloudV2Workspace>>;
  try {
    for (let attempt = 0; ; attempt++) {
      waiting.check();
      try {
        ticket = await waiting.wait(connectCloudV2Workspace(target, { wake, signal: waiting.signal }));
        waiting.check();
        break;
      } catch (error) {
        waiting.check();
        const delay = TICKET_BACKOFF_MS[attempt];
        if (delay === undefined || !transientTicketFailure(error)) throw error;
        let timer: ReturnType<typeof setTimeout> | undefined;
        try { await waiting.wait(new Promise<void>(resolve => { timer = setTimeout(resolve, delay); })); }
        finally { clearTimeout(timer); }
      }
    }
  } finally { waiting.dispose(); }
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

function connected(client: RuntimeClient, signal: AbortSignal): Promise<void> {
  if (client.lastRejection) return Promise.reject(new Error(client.lastRejection.message));
  if (client.status === "connected") return Promise.resolve();
  return new Promise((resolve, reject) => {
    const finish = (error?: Error) => {
      signal.removeEventListener("abort", abort); off();
      if (error) reject(error); else resolve();
    };
    const abort = () => finish(signal.reason);
    const off = client.onStatusChange(status => {
      if (client.lastRejection) { finish(new Error(client.lastRejection.message)); return; }
      if (status !== "connected") return;
      finish();
    });
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
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
  const lifetime = new AbortController();
  const signal = options?.signal ? AbortSignal.any([options.signal, lifetime.signal]) : lifetime.signal;
  const deadline = performance.now() + CONNECT_TIMEOUT_MS;
  const account = cloudCatalogGeneration();
  const owner = cloudWorkspaceOwnerGeneration(target);
  const stop = cloudWorkspaceStopVersion(target);
  const assertCurrent = () => {
    if (signal.aborted) throw new Error("Cloud connection cancelled");
    if (account !== cloudCatalogGeneration()) throw new Error("Cloud account changed while connecting");
    if (owner === undefined || owner !== cloudWorkspaceOwnerGeneration(target)) throw new Error("Cloud workspace owner changed while connecting");
    if (stop !== cloudWorkspaceStopVersion(target)) throw new Error("Cloud workspace was stopped while connecting");
    if (options?.wake && !canOpenCloudWorkspace(target)) throw new Error("The cloud workspace is not available for new work");
  };
  assertCurrent();
  let sequence = 1;
  let opened = false;
  const ticket = await ticketTarget(target, sequence, options?.wake === true, assertCurrent, deadline, signal);
  assertCurrent();
  const client = new RuntimeClient(ticket, {
    // Each reconnect presents a fresh ticket. A reconnect after a laptop wake,
    // network drop or control-plane deploy is not explicit work, so it never
    // restarts a VM that stopped meanwhile. Fresh user input owns the next wake.
    refreshCloudConnectionTarget: async () => {
      assertCurrent();
      const refreshed = await ticketTarget(target, sequence + 1, false, assertCurrent, opened ? performance.now() + TICKET_TIMEOUT_MS : deadline, signal);
      sequence = refreshed.connectionSequence;
      return refreshed;
    },
  });
  const release = () => { lifetime.abort(); client.dispose(); };
  const waiting = connectionWait(assertCurrent, deadline, signal);
  try {
    waiting.check();
    void client.connect();
    await connected(client, waiting.signal);
    waiting.check();
    const workspace = (await waiting.wait(bridgeWorkspaceList(client, {}))).find(row => row.id === target.workspaceId);
    waiting.check();
    if (!workspace?.path || !workspace.path.startsWith("/"))
      throw new Error("Cloud workspace did not confirm its checkout");
    acceptCloudEngineWorkspace(target, workspace, account);
    opened = true;
    return {
      client,
      scope: { ...target, root: workspace.path, engineWorkspaceId: workspace.id },
      runtimeId: target.workspaceId,
      generation: 1,
      release,
    };
  } catch (error) {
    release();
    throw error;
  } finally { waiting.dispose(); }
}
