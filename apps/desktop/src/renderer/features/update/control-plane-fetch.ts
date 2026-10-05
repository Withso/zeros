import { CHANNEL } from "../../config/release-channel";
import { isElectron, isLocalDevelopment, nativeInvoke } from "../../platform/runtime";
import { useRequiredUpdateStore } from "./required-update-state";
import {
  createClientCompatibilityFetch,
  desktopClientHeader,
} from "../../../../shared/client-compatibility";

let identity: Promise<string> | null = null;

function clientHeader(): Promise<string> {
  if (!isElectron())
    return Promise.resolve(desktopClientHeader("dev", "unknown"));
  identity ??= nativeInvoke<unknown>("app_info")
    .then((value) => {
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("Invalid native app info");
      const info = value as Record<string, unknown>;
      if (typeof info.version !== "string")
        throw new Error("Invalid native app info");
      const header = desktopClientHeader(
        info.runtimeMode === "dev" ? "dev" : (info.channel ?? CHANNEL),
        info.version,
      );
      if (header.endsWith("/unknown"))
        throw new Error("Invalid native app info");
      return header;
    })
    .catch(() => {
      identity = null;
      return desktopClientHeader(CHANNEL, "unknown");
    });
  return identity;
}

const hostedControlPlaneFetch = createClientCompatibilityFetch({
  header: clientHeader,
  requireUpgrade: (required) => {
    useRequiredUpdateStore.getState().requireUpdate(required);
    if (isElectron())
      void nativeInvoke("updater_require", required).catch(() => {});
  },
});

export const controlPlaneFetch: typeof hostedControlPlaneFetch = (...args) => {
  if (isLocalDevelopment()) {
    return Promise.reject(
      new Error("Account and cloud services are unavailable in Zeros Local."),
    );
  }
  return hostedControlPlaneFetch(...args);
};
