import { createMessage } from "@zeros/protocol/messages";
import {
  CLOUD_GITHUB_DESKTOP_REQUIRED, cloudGithubNativeDesktopSchema,
  type CloudGithubNativeGrantRequest,
} from "@zeros/protocol/github-auth";
import type { TransportClient } from "../transport/types";

let clients: () => TransportClient[] = () => [];
let ready = new WeakSet<TransportClient>();
const pending = new Map<string, { client: TransportClient; settle(grant: string | null): void }>();
const eligible = (client: TransportClient) => client.kind === "cloud" && client.authorized?.() === true &&
  !!client.cloudActor && ["developer", "manager", "owner"].includes(client.cloudActor.role);
const unavailable = () => new Error(CLOUD_GITHUB_DESKTOP_REQUIRED);

/** Only the cloud engine installs this router. Requests bypass transcript/event
 * capture and go to one admitted desktop of the execution's exact actor. */
export function configureNativeGithubDesktop(read: () => TransportClient[]): void {
  for (const entry of pending.values()) entry.settle(null);
  clients = read;
  ready = new WeakSet();
}
export function acceptNativeGithubDesktop(client: TransportClient, input: unknown): boolean {
  const parsed = cloudGithubNativeDesktopSchema.safeParse(input);
  if (!parsed.success || !eligible(client) || !clients().includes(client)) return false;
  if (parsed.data.kind === "ready") { ready.add(client); return true; }
  const entry = pending.get(parsed.data.requestId);
  if (!entry || entry.client !== client) return false;
  entry.settle(parsed.data.grant);
  return true;
}
export async function requestNativeGithubDesktop(request: CloudGithubNativeGrantRequest, signal: AbortSignal): Promise<{ grant: string; actorSessionId: string }> {
  const client = clients().find(client => eligible(client) && ready.has(client) && client.accountUserId === request.actorUserId);
  if (!client || signal.aborted || pending.size >= 16 || pending.has(request.native.requestId)) throw unavailable();
  return new Promise((resolve, reject) => {
    const finish = (grant: string | null) => {
      if (!pending.delete(request.native.requestId)) return;
      clearTimeout(timer); clearInterval(watch); signal.removeEventListener("abort", abort);
      if (grant && !signal.aborted && eligible(client) && clients().includes(client))
        resolve({ grant, actorSessionId: client.cloudActor!.sessionId });
      else reject(unavailable());
    };
    const abort = () => finish(null);
    const timer = setTimeout(abort, 15000);
    const watch = setInterval(() => { if (!eligible(client) || !clients().includes(client)) abort(); }, 100);
    timer.unref(); watch.unref();
    pending.set(request.native.requestId, { client, settle: finish });
    signal.addEventListener("abort", abort, { once: true });
    try { client.send(createMessage({ type: "GITHUB_NATIVE_GRANT_REQUEST", source: "engine", request })); }
    catch { abort(); }
  });
}
