import { app } from "electron";
import { channel } from "../src/engine/runtime";
import {
  createClientCompatibilityFetch,
  desktopClientHeader,
} from "../shared/client-compatibility";
import { IS_DEV } from "./runtime-mode";
import { signalClientUpgrade } from "./client-upgrade-signal";

export const controlPlaneFetch = createClientCompatibilityFetch({
  header: () =>
    desktopClientHeader(IS_DEV ? "dev" : channel(), app.getVersion()),
  requireUpgrade: signalClientUpgrade,
});
