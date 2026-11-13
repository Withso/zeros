import { CloudCacheRequestSchema, type CloudCacheReply } from "../../shared/cloud-chat-cache";
import { CloudCacheAccessLost, CloudCacheChanged, CloudCacheUnsupported, type CloudChatCacheService } from "./service";

interface Admission { window: number; current(): boolean }
export function createCloudChatCacheCommand<Event>(deps: {
  service(): Promise<CloudChatCacheService>;
  admit(event: Event): Admission;
}): (args: unknown, event: Event) => Promise<CloudCacheReply> {
  return async (args, event) => {
    let admission: Admission | undefined;
    try {
      admission = deps.admit(event);
      const parsed = CloudCacheRequestSchema.safeParse(args);
      if (!parsed.success) return { ok: false, reason: "unavailable" };
      if (!admission.current()) throw new CloudCacheChanged();
      const service = await deps.service();
      if (!admission.current()) throw new CloudCacheChanged();
      const input = parsed.data, window = admission.window;
      let result: unknown;
      switch (input.op) {
        case "bind": result = { lease: service.bind(window, input.owner, input.client) }; break;
        case "read": {
          const pending = service.readPending(window, input.lease, input.target);
          result = { range: service.read(window, input.lease, input.target, input.limit), pending }; break;
        }
        case "read-before": result = service.readBefore(window, input.lease, input.target, input.revision, input.before, input.limit); break;
        case "refresh": result = await service.refresh(window, input.lease, input.target, input.limit); break;
        case "refresh-before": result = await service.refreshBefore(window, input.lease, input.target, input.before, input.limit); break;
        case "refresh-pending": result = await service.refreshPending(window, input.lease, input.target); break;
        case "protect": service.protect(window, input.lease, input.target); result = null; break;
        case "forget": for (const target of input.targets) service.forget(window, input.lease, target); result = null; break;
        case "list": result = service.list(window, input.lease, input.after); break;
        case "release": service.unbind(window, input.lease); result = null; break;
      }
      if (!admission.current()) throw new CloudCacheChanged();
      return { ok: true, result };
    } catch (error) {
      if (admission && !admission.current() || error instanceof CloudCacheChanged) return { ok: false, reason: "owner_changed" };
      if (error instanceof CloudCacheUnsupported) return { ok: false, reason: "unsupported" };
      if (error instanceof CloudCacheAccessLost) return { ok: false, reason: "access_lost", scope: error.scope };
      return { ok: false, reason: "unavailable" };
    }
  };
}
