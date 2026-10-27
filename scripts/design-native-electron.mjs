import { _electron as electron } from "@playwright/test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export function launchNativeElectron(options) {
  // An explicit executable skips Playwright's Electron loader. That loader
  // injects --use-mock-keychain and disables ordinary background scheduling;
  // both invalidate normal Dev authentication and native idle measurements.
  return electron.launch({ ...options, executablePath: require("electron") });
}
