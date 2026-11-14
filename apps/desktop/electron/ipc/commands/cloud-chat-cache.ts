import { app, type IpcMainInvokeEvent } from "electron";
import { existsSync } from "node:fs";
import path from "node:path";
import { zerosDataDir } from "../../../src/engine/db/paths";
import { IS_LOCAL_DEVELOPMENT } from "../../runtime-mode";
import { controlPlaneBaseUrl } from "../../workos-desktop-account";
import { controlPlaneFetch } from "../../control-plane-fetch";
import { getMainWindow } from "../events";
import { getSessionUserForMain, getValidSessionForMain, onMainAuthSessionChanged, onMainAuthSessionRetired } from "./auth-session";
import { createCloudChatCacheCommand } from "../../cloud-chat-cache/commands";
import type { CloudChatCacheService } from "../../cloud-chat-cache/service";
import type { CloudChatCacheStore } from "../../cloud-chat-cache/store";
import type { CommandHandler } from "../router";

interface Runtime { service: CloudChatCacheService; store: CloudChatCacheStore }
let runtime: Runtime | undefined, loading: Promise<Runtime> | undefined;
let retired: Promise<void> = Promise.resolve();
let generation = 0, closed = false;
const windows = new Map<number, { generation: number }>();
const unavailable = () => new Error("Cloud chat cache unavailable.");

function identity(): { owner: string; session: string } | null {
  const user = getSessionUserForMain();
  return user ? { owner: JSON.stringify([controlPlaneBaseUrl(), user.accountId]), session: user.sessionId } : null;
}

async function load(): Promise<Runtime> {
  if (closed || IS_LOCAL_DEVELOPMENT) throw unavailable();
  if (runtime) return runtime;
  if (loading) return loading;
  loading = (async () => {
    const [{ CloudChatCacheStore }, { CloudChatCacheService }, { ControlPlaneCloudChatCacheSource }] = await Promise.all([
      import("../../cloud-chat-cache/store"), import("../../cloud-chat-cache/service"), import("../../cloud-chat-cache/source"),
    ]);
    if (closed) throw unavailable();
    const store = new CloudChatCacheStore(zerosDataDir());
    try {
      const source = new ControlPlaneCloudChatCacheSource({ baseUrl: controlPlaneBaseUrl(), session: getValidSessionForMain, fetch: controlPlaneFetch });
      runtime = { store, service: new CloudChatCacheService({ store, source, identity }) };
      return runtime;
    } catch (error) { store.close(); throw error; }
  })().finally(() => { loading = undefined; });
  return loading;
}

onMainAuthSessionChanged(() => { generation++; runtime?.service.sessionChanged(); });
onMainAuthSessionRetired(session => {
  const owner = JSON.stringify([controlPlaneBaseUrl(), session.accountId]);
  const next = retired.then(async () => {
    if (!runtime && !loading && !existsSync(path.join(zerosDataDir(), "cloud-cache.db"))) return;
    (await load()).service.retireOwner(owner, session.sessionId);
  });
  retired = next.catch(() => {});
  return next;
});
app.once("will-quit", () => { closed = true; generation++; runtime?.service.close(); runtime?.store.close(); });

function admit(event: IpcMainInvokeEvent): { window: number; current(): boolean } {
  const window = getMainWindow(), sender = event.sender, frame = event.senderFrame;
  if (IS_LOCAL_DEVELOPMENT || closed || !window || window.isDestroyed() || sender.isDestroyed() ||
      window.webContents !== sender || sender.mainFrame !== frame) throw unavailable();
  const account = identity();
  if (!account) throw unavailable();
  let lifetime = windows.get(sender.id);
  if (!lifetime) {
    lifetime = { generation: 0 }; windows.set(sender.id, lifetime);
    const captured = lifetime;
    sender.on("did-start-navigation", (_event, _url, inPlace, mainFrame) => {
      if (!mainFrame || inPlace) return;
      captured.generation++; runtime?.service.release(sender.id);
    });
    sender.once("destroyed", () => { captured.generation++; windows.delete(sender.id); runtime?.service.release(sender.id); });
  }
  const authGeneration = generation, frameGeneration = lifetime.generation;
  return { window: sender.id, current: () => {
    try {
      const user = identity();
      return !closed && authGeneration === generation && lifetime.generation === frameGeneration &&
        !window.isDestroyed() && getMainWindow() === window && !sender.isDestroyed() && sender.mainFrame === frame &&
        account.owner === user?.owner && account.session === user.session;
    } catch { return false; }
  } };
}

export const cloudChatCache: CommandHandler = createCloudChatCacheCommand({
  admit, async service() { await retired; return (await load()).service; },
});
