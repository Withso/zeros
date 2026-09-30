import { channel, schemeForChannel } from "../../../src/engine/runtime";
import { controlPlaneFetch } from "../../control-plane-fetch";
import { appBaseUrl } from "../../app-base-url";
import { devWorkOSConfigurationIssue, workspaceDevAuthProfile } from "../../dev-workos-auth-policy";
import { desktopAuthConfig } from "../../workos-desktop-config";
import {
  controlPlaneBaseUrl,
  resolveWorkOSDesktopAccountId,
} from "../../workos-desktop-account";
import { WorkOSDesktopAuthorizationFlow } from "../../workos-desktop-flow";
import { workOSDesktopClientForMain } from "../../workos-desktop-runtime";
import { requestWorkOSDesktopRevocation } from "../../workos-desktop-revocation";
import { emitEvent } from "../events";
import type { CommandHandler } from "../router";
import { cancelLegacyAuthHandoff } from "./auth-handoff";
import { persistWorkOSSession } from "./auth-session";
import { WorkOSDevCallbackRelay } from "../../workos-dev-callback-relay";
import { localDevCallbackStore } from "../../local-dev-callback-store";

let flow: WorkOSDesktopAuthorizationFlow | null = null;
let callbackRelay: WorkOSDevCallbackRelay | null = null;
let localCallbackRelay: WorkOSDevCallbackRelay | null = null;

function isolatedDevCallbackRelay(): WorkOSDevCallbackRelay | null {
  if (channel() !== "dev") return null;
  return (localCallbackRelay ??= new WorkOSDevCallbackRelay(localDevCallbackStore()));
}

/** Share callback routing only for Dev instances using the shared secret store. */
function sharedDevCallbackRelay(): WorkOSDevCallbackRelay | null {
  if (channel() !== "dev" || !process.env.ZEROS_SHARED_SECRETS_DIR?.trim())
    return null;
  return (callbackRelay ??= new WorkOSDevCallbackRelay());
}

/** Lazily bind the main-process authorization flow to browser, account lookup,
 * persistence, and the optional shared Dev callback relay. */
function workOSFlow(): WorkOSDesktopAuthorizationFlow {
  flow ??= new WorkOSDesktopAuthorizationFlow({
    client: workOSDesktopClientForMain(),
    appOrigin: appBaseUrl(),
    deepLinkScheme: schemeForChannel(channel()),
    openExternal: async (url) => {
      const { openDesktopAuthBrowser } = await import("../../deep-link");
      await openDesktopAuthBrowser(url);
    },
    resolveAccountId: (accessToken) => resolveWorkOSDesktopAccountId(accessToken, controlPlaneFetch),
    persistSession: persistWorkOSSession,
    registerCallback: (state, expiresAt, accept) =>
      (workspaceDevAuthProfile() !== undefined ? isolatedDevCallbackRelay() : sharedDevCallbackRelay())?.register(state, expiresAt, accept) ??
      (() => undefined),
    revokeSession: async (accessToken) => {
      if (!(await requestWorkOSDesktopRevocation("current", accessToken, controlPlaneFetch))) {
        throw new Error("The abandoned WorkOS session could not be revoked");
      }
    },
    onComplete: () => emitEvent("auth-signin-complete", {}),
    onError: (reason, context) =>
      emitEvent("auth-signin-error", { reason, ...context }),
  });
  return flow;
}

/** Route an OS callback through the shared Dev store or the local release flow;
 * only the process holding the matching PKCE verifier can finish sign-in. */
export function acceptWorkOSDesktopCallback(input: {
  state: string;
  code?: string | null;
  error?: string | null;
}): boolean {
  const relay = sharedDevCallbackRelay();
  // Any Dev window may receive zeros-dev://. Routing is shared independently
  // from credentials so an isolated workspace can finish its own PKCE flow.
  if (channel() === "dev") {
    try { if (isolatedDevCallbackRelay()?.deliver(input)) return true; }
    catch { console.warn("[auth] Local Dev callback relay unavailable"); }
  }
  return relay?.deliver(input) || (flow?.acceptCallback(input) ?? false);
}

/** Unified entry point: WorkOS stays entirely in Electron main; Auth0 tells the
 * renderer to continue through the compatibility handoff until Phase 5. */
export const authStartSignIn: CommandHandler = async () => {
  let config: ReturnType<typeof desktopAuthConfig>;
  try {
    config = desktopAuthConfig();
  } catch (error) {
    // A partial public-client profile is still a configuration failure, not a
    // reason to fall through to the retired provider. Keep the renderer copy
    // fixed so no identifiers or URLs cross IPC.
    if (channel() === "dev") return { mode: "unconfigured" };
    throw error;
  }
  if (channel() === "dev") {
    let issue: ReturnType<typeof devWorkOSConfigurationIssue> = "provider";
    try {
      issue = devWorkOSConfigurationIssue({
        auth: config,
        appOrigin: appBaseUrl(),
        controlPlaneOrigin: controlPlaneBaseUrl(),
        localProfile: workspaceDevAuthProfile(),
        isolated: process.env.ZEROS_ISOLATE === "1",
      });
    } catch {
      issue = "token_contract";
    }
    if (issue) {
      console.warn(`[Zeros] Dev WorkOS configuration rejected: ${issue}`);
      return { mode: "unconfigured" };
    }
  }
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
