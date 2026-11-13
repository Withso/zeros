import { z } from "zod";
import { getSession } from "../features/auth/auth-store";
import { getOrganizationStoreGeneration } from "../features/team/team-store";
import { CONTROL_PLANE_URL, ControlPlaneError } from "../features/team/control-plane";
import { controlPlaneFetch } from "../features/update/control-plane-fetch";
import type { CloudWorkspaceTarget } from "./bridge/cloud-workspace-key";

/** Team sharing phase 1: GET /v1/cloud-v2/workspaces/:id/events, the passive
 * read channel (team-sharing-wire.md section 4). It never starts or keeps a VM
 * running; it has no replay cursor, so ready and changed mean "read again". */
export type CloudWorkspaceEvent =
  | { event: "ready" }
  | { event: "changed" }
  | { event: "presence"; userIds: string[]; total: number }
  | { event: "heartbeat" }
  | { event: "revoked"; code: string };

const uuid = z.string().uuid();
const Presence = z.object({ userIds: z.array(uuid).max(200), total: z.number().int().min(0).max(1_000_000) }).passthrough();
const Revoked = z.object({ code: z.string().max(64) }).passthrough();
const MAX_FRAME_BYTES = 64 * 1024;

function parseEvent(name: string, data: string): CloudWorkspaceEvent | null {
  let body: unknown = {};
  try { body = data ? JSON.parse(data) : {}; } catch { return null; }
  if (name === "ready" || name === "changed" || name === "heartbeat") return { event: name };
  if (name === "presence") {
    const parsed = Presence.safeParse(body);
    return parsed.success ? { event: "presence", userIds: [...new Set(parsed.data.userIds)], total: parsed.data.total } : null;
  }
  if (name === "revoked") {
    const parsed = Revoked.safeParse(body);
    return { event: "revoked", code: parsed.success ? parsed.data.code : "workspace_access_changed" };
  }
  return null;   // A newer server's event: ignored.
}

/** One stream. Ends when the server ends it; throws on an HTTP or network error. */
export async function* readCloudWorkspaceEvents(target: CloudWorkspaceTarget, signal: AbortSignal): AsyncGenerator<CloudWorkspaceEvent> {
  if (!CONTROL_PLANE_URL) throw new Error("Cloud workspaces are not configured");
  const epoch = getOrganizationStoreGeneration();
  const session = await getSession();
  if (epoch !== getOrganizationStoreGeneration()) throw new Error("Your account changed while loading cloud workspaces");
  if (!session) throw new ControlPlaneError(401, "signed_out", "Sign in to use cloud workspaces");
  const response = await controlPlaneFetch(`${CONTROL_PLANE_URL}/v1/cloud-v2/workspaces/${encodeURIComponent(uuid.parse(target.workspaceId))}/events`, {
    method: "GET", redirect: "error", cache: "no-store", signal,
    headers: { authorization: `Bearer ${session.access_token}`, accept: "text/event-stream", "X-Zeros-Team-Sharing": "1", "X-Zeros-Team-Ownership": "1" },
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new ControlPlaneError(response.status, response.status === 404 ? "not_found" : "cloud_unavailable", "The workspace's updates are unavailable");
  }
  const reader = response.body?.getReader();
  if (!reader) return;
  const decoder = new TextDecoder();
  let buffer = "", name = "message", data: string[] = [];
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) return;
      if (epoch !== getOrganizationStoreGeneration()) throw new Error("Your account changed while loading cloud workspaces");
      buffer += decoder.decode(chunk.value, { stream: true });
      if (buffer.length > MAX_FRAME_BYTES && !buffer.includes("\n")) throw new Error("The workspace's update stream sent an oversized frame");
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        if (line === "") {
          const event = data.length || name !== "message" ? parseEvent(name, data.join("\n")) : null;
          name = "message"; data = [];
          if (event) yield event;
          continue;
        }
        if (line.startsWith(":")) continue;
        const colon = line.indexOf(":");
        const field = colon < 0 ? line : line.slice(0, colon);
        const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
        if (field === "event") name = value;
        else if (field === "data") {
          data.push(value);
          if (data.join("\n").length > MAX_FRAME_BYTES) throw new Error("The workspace's update stream sent an oversized frame");
        }
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}

export interface CloudWorkspaceEventHandlers {
  /** ready or changed: read the document and history again (coalesced). */
  invalidate(): void;
  /** Only when the set of people viewing changes. */
  presence(userIds: readonly string[], total: number): void;
  /** Access ended (revoked, or the workspace is gone): the view stops. */
  ended(code: string): void;
}
export interface CloudWorkspaceEventDeps {
  events?: typeof readCloudWorkspaceEvents;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  now?: () => number;
}
export const CLOUD_EVENTS_SILENCE_MS = 70_000;
const HEALTHY_STREAM_MS = 30_000;

const abortableSleep = (ms: number, signal: AbortSignal) => new Promise<void>(resolve => {
  const timer = setTimeout(resolve, ms);
  signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
});

/** Keep the stream open while the caller holds it. A clean end of a healthy
 * stream (the token's end) reconnects at once; a stream silent for 70 s is
 * aborted and reopened; errors back off to 30 s; revoked, 403 and 404 stop it.
 * Heartbeats only feed the watchdog: they never cause a read. */
export function watchCloudWorkspaceEvents(target: CloudWorkspaceTarget, handlers: CloudWorkspaceEventHandlers, deps: CloudWorkspaceEventDeps = {}): () => void {
  const events = deps.events ?? readCloudWorkspaceEvents, sleep = deps.sleep ?? abortableSleep, now = deps.now ?? Date.now;
  const stop = new AbortController();
  const generation = getOrganizationStoreGeneration();
  let presence: string | null = null;
  void (async () => {
    let failures = 0;
    while (!stop.signal.aborted && generation === getOrganizationStoreGeneration()) {
      const stream = new AbortController();
      const abortStream = () => stream.abort();
      stop.signal.addEventListener("abort", abortStream, { once: true });
      let watchdog: ReturnType<typeof setTimeout> | undefined;
      const feed = () => { clearTimeout(watchdog); watchdog = setTimeout(() => stream.abort(), CLOUD_EVENTS_SILENCE_MS); };
      const opened = now();
      let ready = false;
      try {
        feed();
        for await (const event of events(target, stream.signal)) {
          feed();
          if (stop.signal.aborted) return;
          if (event.event === "ready") { ready = true; failures = 0; handlers.invalidate(); }
          else if (event.event === "changed") handlers.invalidate();
          else if (event.event === "presence") {
            const key = JSON.stringify([[...event.userIds].sort(), event.total]);
            if (key !== presence) { presence = key; handlers.presence(event.userIds, event.total); }
          } else if (event.event === "revoked") { stop.abort(); handlers.ended(event.code); return; }
        }
        // A clean end: at once after a healthy stream, backed off after one that ended at once.
        if (ready && now() - opened >= HEALTHY_STREAM_MS) { failures = 0; continue; }
        failures++;
      } catch (error) {
        if (stop.signal.aborted) return;
        const status = error instanceof ControlPlaneError ? error.status : 0;
        if (status === 403 || status === 404) { stop.abort(); handlers.ended(status === 404 ? "not_found" : "forbidden"); return; }
        // A silent stream the watchdog aborted reconnects at once.
        if (stream.signal.aborted && ready) { failures = 0; continue; }
        failures++;
      } finally {
        clearTimeout(watchdog);
        stop.signal.removeEventListener("abort", abortStream);
        stream.abort();
      }
      await sleep(Math.min(30_000, 1000 * 2 ** Math.min(failures - 1, 5)), stop.signal);
    }
  })();
  return () => stop.abort();
}
