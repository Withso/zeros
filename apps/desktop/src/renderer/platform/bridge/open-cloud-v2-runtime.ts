// Opens a cloud v2 workspace for the shared runtime client: one control-plane
// relay socket to the workspace worker, authenticated by a short-lived ticket.
// The worker answers the same bridge frames as a Local engine, so the shared
// UI needs no cloud-only agent, history or event layer.
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
/** The control plane holds this ticket's relay socket until the worker is ready (bounded), so a waking workspace costs
 * one connect: churn before ready ends the open instead of minting another ticket. */
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
  // An unbounded wait (Infinity) arms no timer: an over-large delay would fire at once.
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

/** §14.5: waits out this workspace's shared connect backoff before any POST connect, bounded only by the open's own
 * deadline and cancellation (not the 30 s ticket window, which a grown backoff would always exceed). */
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
        // Every transient failure (503 included) grows the shared backoff; only a ready connection resets it.
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
  // §14.7: one instance id per opened peer, in memory only; it binds this peer's connect and renewal tickets.
  const clientInstance = crypto.randomUUID();
  const { features, ...ticket } = await ticketTarget(target, sequence, options?.wake === true, assertCurrent, deadline, signal, clientInstance);
  assertCurrent();
  // R1 relay-presence-v1: an admission with the feature makes this live connection count as presence.
  let presenceAdmitted = features?.includes(RELAY_PRESENCE_FEATURE) === true;
  const readyHeld = features?.includes(CONNECT_READY_FEATURE) === true;
  const beforeReady = new AbortController();
  let endPresence: (() => void) | undefined;
  const client = new RuntimeClient(ticket, {
    // D2: a 4001 access_revoked ends access only once the workspace document confirms it.
    confirmCloudAccessEnded: workspace => confirmCloudWorkspaceAccessEnded(workspace),
    // §14.7: a renewal ticket for the SAME socket: never wakes, same instance, a bearer newer than the one presented.
    renewCloudConnectionTicket: async notExpiringBefore => {
      assertCurrent();
      const presented = { expiresAt: null as number | null };
      const minted = await connectCloudV2Workspace(target, { wake: false, signal, clientInstance, notExpiringBefore,
        presentedTokenExpiry: value => { presented.expiresAt = value; } });
      assertCurrent();
      return { ticket: minted.protocols[1].slice("ticket.".length), tokenExpiresAt: presented.expiresAt };
    },
    // Each reconnect presents a fresh ticket. A reconnect after a laptop wake,
    // network drop or control-plane deploy is not explicit work, so it never
    // restarts a VM that stopped meanwhile. Fresh user input owns the next wake.
    refreshCloudConnectionTarget: async () => {
      assertCurrent();
      if (readyHeld && !opened) {
        // connect-ready-v1: the one socket was the whole wait. Its loss before ready ends this open (no new connect
        // while the workspace is still waking); fresh user input owns the next attempt.
        const error = new Error("The cloud workspace connection ended before it was ready. Try again.");
        beforeReady.abort(error);
        throw error;
      }
      // After the open, the ticket window starts once the shared backoff has passed (Infinity: no outer deadline).
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
    // The worker answered, so the control plane already has it running. Read
    // that now rather than at the catalog's next poll (every 2 s, and paused
    // while the window is hidden), which left Running ~25 s late on Alpha.
    if (isCloudWorkspaceLifecyclePending(cloudWorkspaceDocument(target))) void refreshCloudWorkspace(target).catch(() => {});
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
    // connect-ready-v1: name why the open ended (the socket was lost before ready), not a generic cancellation.
    throw beforeReady.signal.aborted ? beforeReady.signal.reason : error;
  } finally { waiting.dispose(); }
}
