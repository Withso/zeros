import { createMessage } from "@zeros/protocol/messages";
import {
  CLOUD_GITHUB_DESKTOP_REQUIRED, cloudGithubNativeDesktopSchema,
  type CloudGithubNativeGrantRequest,
} from "@zeros/protocol/github-auth";
import type { TransportClient } from "../transport/types";

let clients: () => TransportClient[] = () => [];
let ready = new WeakSet<TransportClient>();
const pending = new Map<string, { client: TransportClient; settle(grant: string | null): void; current(): boolean; abort(): void }>();
const eligible = (client: TransportClient) => client.kind === "cloud" && client.authorized?.() === true &&
  !!client.cloudActor && ["developer", "manager", "owner"].includes(client.cloudActor.role);
const unavailable = () => new Error(CLOUD_GITHUB_DESKTOP_REQUIRED);

/** Only the cloud engine installs this router. Requests bypass transcript/event
 * capture and go to one admitted desktop of the execution's exact actor. */
export function configureNativeGithubDesktop(read: () => TransportClient[]): void {
  for (const entry of [...pending.values()]) entry.abort();
  clients = read;
  ready = new WeakSet();
}
export function acceptNativeGithubDesktop(client: TransportClient, input: unknown): boolean {
  const parsed = cloudGithubNativeDesktopSchema.safeParse(input);
  if (!parsed.success || !eligible(client) || !clients().includes(client)) return false;
  if (parsed.data.kind === "ready") { ready.add(client); return true; }
  const entry = pending.get(parsed.data.requestId);
  if (!entry || entry.client !== client || !entry.current()) return false;
  entry.settle(parsed.data.grant);
  return true;
}
export async function requestNativeGithubDesktop(request: CloudGithubNativeGrantRequest, signal: AbortSignal): Promise<{ grant: string; actorSessionId: string }> {
  const matches = (client: TransportClient) => eligible(client) && ready.has(client) &&
    client.accountUserId === request.actorUserId && clients().includes(client);
  // Snapshot at most four distinct ready devices. A null preparation can try
  // another exact-actor device; a disconnect, cancel or expired deadline ends
  // the operation. Never race preparations or restart the 15-second budget.
  const candidates = [...new Set(clients().filter(matches))].slice(0, 4);
  if (!candidates.length || signal.aborted || pending.size >= 16 || pending.has(request.native.requestId)) throw unavailable();
  const deadline = Date.now() + 15_000;
  return new Promise((resolve, reject) => {
    let selected: TransportClient | undefined, sessionId: string | undefined;
    let index = 0, settled = false;
    const current = () => !!selected && matches(selected) && selected.cloudActor!.sessionId === sessionId;
    const finish = (grant: string | null) => {
      if (settled) return;
      settled = true;
      pending.delete(request.native.requestId);
      clearTimeout(timer); clearInterval(watch); signal.removeEventListener("abort", abort);
      if (grant && !signal.aborted && Date.now() < deadline && current())
        resolve({ grant, actorSessionId: sessionId! });
      else reject(unavailable());
    };
    const abort = () => finish(null);
    const next = () => {
      if (settled || signal.aborted || Date.now() >= deadline) { abort(); return; }
      selected = candidates.slice(index).find(matches);
      if (!selected) { abort(); return; }
      index = candidates.indexOf(selected) + 1;
      sessionId = selected.cloudActor!.sessionId;
      pending.set(request.native.requestId, { client: selected, current, abort,
        settle: grant => { if (grant) finish(grant); else next(); } });
      try { selected.send(createMessage({ type: "GITHUB_NATIVE_GRANT_REQUEST", source: "engine", request })); }
      catch { abort(); }
    };
    const timer = setTimeout(abort, 15_000);
    const watch = setInterval(() => { if (!current()) abort(); }, 100);
    timer.unref(); watch.unref();
    signal.addEventListener("abort", abort, { once: true });
    next();
  });
}
