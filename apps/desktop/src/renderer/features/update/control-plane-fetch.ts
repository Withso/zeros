import { CHANNEL } from "../../config/release-channel";
import { isElectron, nativeInvoke } from "../../platform/runtime";
import { useRequiredUpdateStore } from "./required-update-state";
import {
  createClientCompatibilityFetch,
  desktopClientHeader,
} from "../../../../shared/client-compatibility";

let identity: Promise<string> | null = null;

function clientHeader(): Promise<string> {
  if (!isElectron())
    return Promise.resolve(desktopClientHeader("dev", "unknown"));
  identity ??= nativeInvoke<{
    channel?: string;
    version?: string;
    runtimeMode?: string;
  }>("app_info").then(
    (info) =>
      desktopClientHeader(
        info.runtimeMode === "dev" ? "dev" : (info.channel ?? CHANNEL),
        info.version ?? "unknown",
      ),
    () => {
      identity = null;
      return desktopClientHeader(CHANNEL, "unknown");
    },
  );
  return identity;
}

export const controlPlaneFetch = createClientCompatibilityFetch({
  header: clientHeader,
  requireUpgrade: (required) => {
    useRequiredUpdateStore.getState().requireUpdate(required);
    if (isElectron())
      void nativeInvoke("updater_require", required).catch(() => {});
  },
});
