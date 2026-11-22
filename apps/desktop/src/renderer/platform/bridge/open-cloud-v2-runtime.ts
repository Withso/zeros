import type { CloudWorkspaceDocument } from "../cloud-workspace-contract";
import type { CloudV2ConnectionTarget } from "@zeros/protocol/cloud-runtime-connection";
import { connectCloudV2Workspace } from "../cloud-v2";
import { ControlPlaneError } from "../../features/team/control-plane";
import {
  acceptCloudEngineWorkspace, cloudCatalogGeneration, cloudWorkspaceDocument,
  cloudWorkspaceOwnerGeneration, cloudWorkspaceStopVersion, isCloudWorkspaceLifecyclePending,
  refreshCloudWorkspace, subscribeCloudWorkspaces,
} from "../../state/cloud-workspace-catalog";
import { canOpenCloudWorkspace } from "../../state/cloud-workspace-wake";
import type { CloudWorkspaceTarget } from "./cloud-workspace-key";
import { RuntimeClient } from "./ws-client";
import type { CloudPeer } from "./workspace-runtime-client";
import { bridgeWorkspaceList } from "./workspace-bridge";
import { confirmCloudWorkspaceAccessEnded } from "../cloud-access-confirm";
import { cloudConnectBackoffKey, cloudConnectWaitMs, recordCloudConnectFailure } from "./cloud-connect-backoff";
import { setRelayPresence } from "./relay-presence";

const RELAY_PRESENCE_FEATURE = "relay-presence-v1";
/** With connect-ready-v1, the control plane holds a bounded socket open while its worker becomes ready. */
const CONNECT_READY_FEATURE = "connect-ready-v1";

const CONNECT_TIMEOUT_MS = 3 * 60_000;
const TICKET_TIMEOUT_MS = 30_000;
const TICKET_ATTEMPTS = 5;

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
  // Do not arm a timer for Infinity; an oversized delay fires immediately.
  const timer = Number.isFinite(deadline) ? setTimeout(timeout, Math.max(0, deadline - performance.now())) : undefined;
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

/** Shared backoff waits outside the ticket window but still respects the open deadline. */
async function backoffGate(key: string, assertCurrent: () => void, deadline: number, signal?: AbortSignal): Promise<void> {
  const delay = cloudConnectWaitMs(key);
  if (delay <= 0) return;
  const waiting = connectionWait(assertCurrent, deadline, signal);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { await waiting.wait(new Promise<void>(resolve => { timer = setTimeout(resolve, delay); })); waiting.check(); }
  finally { clearTimeout(timer); waiting.dispose(); }
}

async function ticketTarget(
  target: CloudWorkspaceTarget, sequence: number, wake: boolean,
  assertCurrent: () => void, deadline: number, signal?: AbortSignal, clientInstance?: string,
): Promise<CloudV2ConnectionTarget & { features?: string[] }> {
  const backoff = cloudConnectBackoffKey(target);
  await backoffGate(backoff, assertCurrent, deadline, signal);
  const windowEnd = Math.min(deadline, performance.now() + TICKET_TIMEOUT_MS);
  const waiting = connectionWait(assertCurrent, windowEnd, signal);
  let ticket: Awaited<ReturnType<typeof connectCloudV2Workspace>>;
  try {
    for (let attempt = 0; ; attempt++) {
      waiting.check();
      try {
        ticket = await waiting.wait(connectCloudV2Workspace(target, { wake, signal: waiting.signal, ...(clientInstance ? { clientInstance } : {}) }));
        waiting.check();
        break;
      } catch (error) {
        waiting.check();
        if (!transientTicketFailure(error)) throw error;
        const delay = recordCloudConnectFailure(backoff);
        if (attempt + 1 >= TICKET_ATTEMPTS || performance.now() + delay >= windowEnd) throw error;
        let timer: ReturnType<typeof setTimeout> | undefined;
        try { await waiting.wait(new Promise<void>(resolve => { timer = setTimeout(resolve, delay); })); }
        finally { clearTimeout(timer); }
      }
    }
  } finally { waiting.dispose(); }
  return {
    kind: "cloud",
    channel: "v2-websocket",
    // V2 uses the workspace ID as the runtime identity and a fixed generation.
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
    ...(ticket.features ? { features: ticket.features } : {}),
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

/** Only explicit opens may wake a VM; passive readers use control-plane history while it is stopped. */
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
  // Keep one memory-only instance ID to bind this peer's initial and renewal tickets.
  const clientInstance = crypto.randomUUID();
  const { features, ...ticket } = await ticketTarget(target, sequence, options?.wake === true, assertCurrent, deadline, signal, clientInstance);
  assertCurrent();
  let presenceAdmitted = features?.includes(RELAY_PRESENCE_FEATURE) === true;
  const readyHeld = features?.includes(CONNECT_READY_FEATURE) === true;
  const beforeReady = new AbortController();
  let endPresence: (() => void) | undefined;
  const client = new RuntimeClient(ticket, {
    // A relay 4001 revocation is terminal only after the workspace document confirms it.
    confirmCloudAccessEnded: workspace => confirmCloudWorkspaceAccessEnded(workspace),
    // Renew the same socket without waking the VM, using a bearer newer than the one presented.
    renewCloudConnectionTicket: async notExpiringBefore => {
      assertCurrent();
      const presented = { expiresAt: null as number | null };
      const minted = await connectCloudV2Workspace(target, { wake: false, signal, clientInstance, notExpiringBefore,
        presentedTokenExpiry: value => { presented.expiresAt = value; } });
      assertCurrent();
      return { ticket: minted.protocols[1].slice("ticket.".length), tokenExpiresAt: presented.expiresAt };
    },
    // Network recovery is not user intent and must not wake a VM that stopped meanwhile.
    refreshCloudConnectionTarget: async () => {
      assertCurrent();
      if (readyHeld && !opened) {
        // With connect-ready-v1, losing the socket before ready ends this open instead of minting another ticket.
        const error = new Error("The cloud workspace connection ended before it was ready. Try again.");
        beforeReady.abort(error);
        throw error;
      }
      const { features: renewed, ...refreshed } = await ticketTarget(target, sequence + 1, false, assertCurrent, opened ? Infinity : deadline, signal, clientInstance);
      sequence = refreshed.connectionSequence;
      presenceAdmitted = renewed?.includes(RELAY_PRESENCE_FEATURE) === true;
      return refreshed;
    },
  });
  const syncPresence = () => {
    const live = presenceAdmitted && client.status === "connected" && !lifetime.signal.aborted;
    if (live && !endPresence) endPresence = setRelayPresence(target);
    else if (!live && endPresence) { endPresence(); endPresence = undefined; }
  };
  const offPresence = client.onStatusChange(syncPresence);
  const release = () => { lifetime.abort(); offPresence(); syncPresence(); client.dispose(); };
  const waiting = connectionWait(assertCurrent, deadline, AbortSignal.any([signal, beforeReady.signal]));
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
    // The worker has answered; refresh the pending catalog state without waiting for its next poll.
    if (isCloudWorkspaceLifecyclePending(cloudWorkspaceDocument(target))) void refreshCloudWorkspace(target).catch(() => {});
    opened = true;
    return {
      client,
      scope: { ...target, root: cloudRuntimeRoot(cloudWorkspaceDocument(target), workspace.path), engineWorkspaceId: workspace.id },
      runtimeId: target.workspaceId,
      generation: 1,
      release,
    };
  } catch (error) {
    release();
    // Surface a lost readiness socket rather than the generic cancellation it triggered.
    throw beforeReady.signal.aborted ? beforeReady.signal.reason : error;
  } finally { waiting.dispose(); }
}

/** A workspace of several repositories is rooted at its project folder, so each
 * repository is a folder of the workspace (`<key>/<folder>`) and file paths are
 * relative to the project folder. Only when the worker's confirmed checkout is
 * the document's first repository, directly inside that folder; otherwise the
 * confirmed checkout, as for one repository. */
export function cloudRuntimeRoot(document: Pick<CloudWorkspaceDocument, "root" | "repositories"> | null | undefined, checkout: string): string {
  const root = document?.root, first = document?.repositories?.[0];
  return root && first && first.checkoutPath === checkout && checkout.startsWith(`${root}/`) && !checkout.slice(root.length + 1).includes("/")
    ? root : checkout;
}

