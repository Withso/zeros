import { shell } from "electron";

import { channel, schemeForChannel } from "../../../src/engine/runtime";
import { appBaseUrl } from "../../app-base-url";
import { desktopAuthConfig } from "../../workos-desktop-config";
import { resolveWorkOSDesktopAccountId } from "../../workos-desktop-account";
import { WorkOSDesktopAuthorizationFlow } from "../../workos-desktop-flow";
import { workOSDesktopClientForMain } from "../../workos-desktop-runtime";
import { requestWorkOSDesktopRevocation } from "../../workos-desktop-revocation";
import { emitEvent } from "../events";
import type { CommandHandler } from "../router";
import { cancelLegacyAuthHandoff } from "./auth-handoff";
import { persistWorkOSSession } from "./auth-session";

let flow: WorkOSDesktopAuthorizationFlow | null = null;

function workOSFlow(): WorkOSDesktopAuthorizationFlow {
  flow ??= new WorkOSDesktopAuthorizationFlow({
    client: workOSDesktopClientForMain(),
    appOrigin: appBaseUrl(),
    deepLinkScheme: schemeForChannel(channel()),
    openExternal: (url) => shell.openExternal(url),
    resolveAccountId: resolveWorkOSDesktopAccountId,
    persistSession: persistWorkOSSession,
    revokeSession: async (accessToken) => {
      if (!(await requestWorkOSDesktopRevocation("current", accessToken))) {
        throw new Error("The abandoned WorkOS session could not be revoked");
      }
    },
    onComplete: () => emitEvent("auth-signin-complete", {}),
    onError: (reason, context) =>
      emitEvent("auth-signin-error", { reason, ...context }),
  });
  return flow;
}

export function acceptWorkOSDesktopCallback(input: {
  state: string;
  code?: string | null;
  error?: string | null;
}): boolean {
  return flow?.acceptCallback(input) ?? false;
}

/** Unified entry point: WorkOS stays entirely in Electron main; Auth0 tells the
 * renderer to continue through the compatibility handoff until Phase 5. */
export const authStartSignIn: CommandHandler = async () => {
  const config = desktopAuthConfig();
  if (config.provider === "auth0") return { mode: "auth0" };
  cancelLegacyAuthHandoff();
  const attempt = await workOSFlow().start();
  return { mode: "workos", expiresAt: attempt.expiresAt };
};

export const authCancelSignIn: CommandHandler = () => {
  flow?.cancel();
  cancelLegacyAuthHandoff();
  return true;
};
