import { app } from "electron";
import { channel } from "../src/engine/runtime";
import {
  createClientCompatibilityFetch,
  desktopClientHeader,
} from "../shared/client-compatibility";
import { IS_DEV, IS_LOCAL_DEVELOPMENT } from "./runtime-mode";
import { signalClientUpgrade } from "./client-upgrade-signal";

const hostedControlPlaneFetch = createClientCompatibilityFetch({
  header: () =>
    desktopClientHeader(IS_DEV ? "dev" : channel(), app.getVersion()),
  requireUpgrade: signalClientUpgrade,
});

export const controlPlaneFetch: typeof hostedControlPlaneFetch = (...args) => {
  if (IS_LOCAL_DEVELOPMENT) {
    return Promise.reject(
      new Error("Account and cloud services are unavailable in Zeros Local."),
    );
  }
  return hostedControlPlaneFetch(...args);
};
