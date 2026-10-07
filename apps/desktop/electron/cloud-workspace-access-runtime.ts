import { app, clipboard } from "electron";
import path from "node:path";

import { CloudWorkspaceAccessBroker, type CloudServiceContext } from "./cloud-workspace-access-broker";
import { CloudWorkspacePortForwarding } from "./cloud-workspace-port-forwarding";
import { CloudPortForwardingPreferences, type CloudPortForwardingState } from "./cloud-workspace-port-forwarding-store";
import { cloudWorkspaceDesktopCapabilityEnabled } from "../src/engine/cloud-workspace-capability";
import { CloudWorkspaceAccessClient } from "./cloud-workspace-access-client";
import { CloudWorkspaceNativeSshRuntime, CloudWorkspaceSshRuntime } from "./cloud-workspace-ssh-runtime";
import { CloudRuntimeServiceClient } from "./cloud-runtime-service-client";
import { CloudRuntimeServiceTransport } from "./cloud-runtime-service-transport";
import { ensureCloudAccessDeviceForMain, readCloudAccessDeviceForMain, signCloudEngineAdmissionForMain, signCloudRuntimeServiceForMain, signCloudPreviewForMain } from "./cloud-replica-host-runtime";
import { previewFrameAuthorizations } from "./preview-frame-authorizations";
import {
  getValidAccessTokenForMain,
  getSessionUserForMain,
  onMainAuthSessionChanged,
} from "./ipc/commands/auth-session";
import { emitEvent } from "./ipc/events";
import { IS_DEV } from "./runtime-mode";
import { controlPlaneFetch } from "./control-plane-fetch";

declare const __ZEROS_CONTROL_PLANE_URL_BAKED__: string | undefined;
declare const __ZEROS_CLOUD_PREVIEW_HOST_SUFFIXES_BAKED__: string | undefined;
declare const __ZEROS_CLOUD_SSH_KNOWN_HOSTS_B64_BAKED__: string | undefined;

let broker: CloudWorkspaceAccessBroker | null = null;
let forwarding: { broker: CloudWorkspaceAccessBroker; coordinator: CloudWorkspacePortForwarding } | null = null;
let forwardingPreferences: CloudPortForwardingPreferences | null = null;
function readForwardingSession() {
  const user = getSessionUserForMain();
  return user ? { accountId: JSON.stringify([user.provider, user.accountId ?? user.sub]),
    sessionKey: JSON.stringify([user.provider, user.accountId ?? user.sub, user.sessionId ?? null]) } : null;
}
let forwardingSession: ReturnType<typeof readForwardingSession> = null;
// Auth storage uses Electron's application paths. Capture the boot identity
// after readiness, without adding native reads to import-only Local paths.
void app?.whenReady?.().then(() => { forwardingSession ??= readForwardingSession(); });

function getForwardingPreferences(): CloudPortForwardingPreferences {
  return forwardingPreferences ??= new CloudPortForwardingPreferences(path.join(app.getPath("userData"), "cloud-port-forwarding.json"));
}

async function retireForwarding(pruneAccount: boolean): Promise<void> {
  const previous = forwarding; forwarding = null;
  await previous?.coordinator.dispose({ pruneAccount });
}

function controlPlaneBaseUrl(): string {
  const baked =
    typeof __ZEROS_CONTROL_PLANE_URL_BAKED__ === "string"
      ? __ZEROS_CONTROL_PLANE_URL_BAKED__
      : "";
  return (
    process.env.ZEROS_CONTROL_PLANE_URL?.trim() ||
    process.env.VITE_CONTROL_PLANE_URL?.trim() ||
    baked.trim() ||
    "https://api.zeros.build"
  );
}

function allowedSshHosts(): string[] | undefined {
  const raw = process.env.ZEROS_CLOUD_SSH_HOSTS?.trim();
  if (!raw) return undefined;
  const hosts = raw
    .split(",")
    .map((host) => host.trim())
    .filter(Boolean);
  return hosts.length > 0 ? hosts : undefined;
}

function pinnedSshKnownHostEntries(): string[] | undefined {
  const baked =
    typeof __ZEROS_CLOUD_SSH_KNOWN_HOSTS_B64_BAKED__ === "string"
      ? __ZEROS_CLOUD_SSH_KNOWN_HOSTS_B64_BAKED__
      : "";
  const raw =
    process.env.ZEROS_CLOUD_SSH_KNOWN_HOSTS_B64?.trim() || baked.trim();
  if (!raw) return undefined;
  if (raw.length > 128 * 1024 || !/^[A-Za-z0-9_-]+$/u.test(raw)) {
    throw new Error("Cloud workspace SSH host keys are invalid");
  }
  const bytes = Buffer.from(raw, "base64url");
  try {
    if (
      bytes.length < 16 ||
      bytes.length > 96 * 1024 ||
      bytes.toString("base64url") !== raw
    ) {
      throw new Error("Cloud workspace SSH host keys are invalid");
    }
    const document = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const entries = document.endsWith("\n")
      ? document.slice(0, -1).split("\n")
      : document.split("\n");
    if (
      entries.length < 1 ||
      entries.length > 32 ||
      entries.some((entry) => !entry || entry.endsWith("\r"))
    ) {
      throw new Error("Cloud workspace SSH host keys are invalid");
    }
    return entries;
  } finally {
    bytes.fill(0);
  }
}

function allowSshTrustOnFirstUse(): boolean {
  return IS_DEV && process.env.ZEROS_CLOUD_SSH_ALLOW_TOFU === "true";
}

function allowedPreviewHostSuffixes(): string[] | undefined {
  const baked =
    typeof __ZEROS_CLOUD_PREVIEW_HOST_SUFFIXES_BAKED__ === "string"
      ? __ZEROS_CLOUD_PREVIEW_HOST_SUFFIXES_BAKED__
      : "";
  const raw =
    process.env.ZEROS_CLOUD_PREVIEW_HOST_SUFFIXES?.trim() || baked.trim();
  if (!raw) return undefined;
  const suffixes = raw
    .split(",")
    .map((suffix) => suffix.trim())
    .filter(Boolean);
  return suffixes.length > 0 ? suffixes : undefined;
}

export function getCloudWorkspaceAccessBroker(): CloudWorkspaceAccessBroker {
  if (!cloudWorkspaceDesktopCapabilityEnabled()) {
    throw new Error("Cloud workspaces are not enabled in this desktop build");
  }
  if (broker?.hasCurrentSession()) return broker;
  void retireForwarding(true).catch(() => undefined);
  broker = null;
  const hosts = allowedSshHosts();

  const previewHostSuffixes = allowedPreviewHostSuffixes();
  const serviceTransport = new CloudRuntimeServiceTransport({ baseUrl: controlPlaneBaseUrl(), allowInsecureLoopback: IS_DEV });
  const nativeSsh = new CloudWorkspaceNativeSshRuntime({
    runtimeRoot: path.join(app.getPath("sessionData"), "cloud-native-ssh"), transport: serviceTransport,
  });
  let ssh: CloudWorkspaceSshRuntime | null = null;
  const getSsh = () => {
    if (ssh) return ssh;
    const knownHostEntries = pinnedSshKnownHostEntries();
    ssh = new CloudWorkspaceSshRuntime({
    runtimeRoot: path.join(app.getPath("sessionData"), "cloud-ssh"),
    knownHostsPath: path.join(app.getPath("userData"), "cloud-ssh-known-hosts"),
    ...(hosts ? { allowedSshHosts: hosts } : {}),
    ...(knownHostEntries ? { knownHostEntries } : {}),
    allowTrustOnFirstUse: !knownHostEntries && allowSshTrustOnFirstUse(),
  });
    return ssh;
  };
  const current = new CloudWorkspaceAccessBroker({
    nativeServices: {
      api: new CloudRuntimeServiceClient({ baseUrl: controlPlaneBaseUrl(), fetch: controlPlaneFetch,
        sign: signCloudRuntimeServiceForMain, allowInsecureLoopback: IS_DEV }),
      readDeviceIdentity: readCloudAccessDeviceForMain,
      prepareSsh: access => nativeSsh.prepare(access),
      startTunnel: (access, localPort) => serviceTransport.startTunnel(access, localPort),
    },
    api: new CloudWorkspaceAccessClient({
      fetch: controlPlaneFetch,
      baseUrl: controlPlaneBaseUrl(),
      signEngineAdmission: signCloudEngineAdmissionForMain,
      signPreview: signCloudPreviewForMain,
      allowInsecureLoopback: IS_DEV,
      ...(hosts ? { allowedSshHosts: hosts } : {}),
      ...(previewHostSuffixes
        ? { allowedPreviewHostSuffixes: previewHostSuffixes }
        : {}),
    }),
    getAccessToken: getValidAccessTokenForMain,
    getAccountSessionKey: () => {
      const user = getSessionUserForMain();
      if (!user) return null;
      return JSON.stringify([user.provider, user.accountId ?? user.sub, user.sessionId ?? null]);
    },
    onRuntimeRetired: (runtimeIds) => {
      if (forwarding?.broker === current) for (const id of runtimeIds) forwarding.coordinator.retireRuntime(id);
      emitEvent("cloud-workspace-access-retired", { runtimeIds });
    },
    getDeviceId: async () => (await ensureCloudAccessDeviceForMain()).deviceId,
    writeClipboard: (value) => clipboard.writeText(value),
    launchTerminal: (input) => getSsh().launchTerminal(input),
    launchIde: (input) => getSsh().launchIde(input),
    startTunnel: (input) => getSsh().startTunnel(input),
    startDynamicTunnel: (input) => getSsh().startDynamicTunnel(input),
    disposeLocalAccess: async () => { await Promise.all([ssh?.dispose(), nativeSsh.dispose(), serviceTransport.dispose()]); },
  });
  broker = current;
  return broker;
}

export function getCloudWorkspacePortForwarding(): CloudWorkspacePortForwarding {
  const current = getCloudWorkspaceAccessBroker();
  if (forwarding?.broker === current) return forwarding.coordinator;
  const user = getSessionUserForMain();
  if (!user) throw new Error("Sign in before changing cloud forwarding.");
  const accountId = JSON.stringify([user.provider, user.accountId ?? user.sub]);
  const client = new CloudWorkspaceAccessClient({ baseUrl: controlPlaneBaseUrl(), fetch: controlPlaneFetch, allowInsecureLoopback: IS_DEV });
  const coordinator = new CloudWorkspacePortForwarding({ broker: current, preferences: getForwardingPreferences(), accountId,
    readPorts: async (runtime, signal) => {
      current.assertRuntime(runtime);
      const token = await getValidAccessTokenForMain();
      current.assertRuntime(runtime);
      if (!token || signal.aborted) throw new Error("Cloud forwarding authority has ended.");
      const result = await client.readDetectedPorts(token, runtime, signal);
      current.assertRuntime(runtime);
      return result;
    },
  });
  forwarding = { broker: current, coordinator };
  return coordinator;
}

export async function setCloudWorkspacePortForwardingPreferences(
  input: { organizationId: string; workspaceId: string } & CloudServiceContext, change: Partial<CloudPortForwardingState>,
): Promise<Readonly<CloudPortForwardingState>> {
  const current = getCloudWorkspaceAccessBroker();
  current.listServices(input);
  if (!input.deviceId) {
    // A switch mutation is explicit user intent; passive preference/context
    // reads never enroll a device or obtain a token.
    await ensureCloudAccessDeviceForMain();
    if (!current.hasCurrentSession()) throw new Error("Cloud forwarding account has changed.");
  }
  return getCloudWorkspacePortForwarding().setPreferences({ ...input, ...current.serviceContext() }, change);
}

export function revokeCloudWorkspaceNativeAccess(accessId: string): Promise<boolean> {
  const current = getCloudWorkspaceAccessBroker();
  return forwarding?.broker === current ? forwarding.coordinator.revoke(accessId) : current.revoke(accessId);
}

export async function disposeCloudWorkspaceAccessBroker(): Promise<void> {
  previewFrameAuthorizations.clear();
  const current = broker;
  const forwardingCleanup = retireForwarding(false);
  broker = null;
  await Promise.all([forwardingCleanup, current?.dispose()]);
}

export function revokeCloudWorkspacePreviewFrame(
  frameName: string,
): Promise<boolean> {
  return broker ? broker.revokePreviewFrame(frameName) : Promise.resolve(false);
}

// Account replacement and sign-out invalidate every device-local bearer and
// tunnel. The broker retains only the last account token that actually issued
// its grants long enough to attempt remote revocation; provider TTL and
// lifecycle revocation remain the durable backstop when the network is down.
export function reconcileCloudWorkspaceAccessSession(): void {
  const previousSession = forwardingSession;
  forwardingSession = readForwardingSession();
  if (broker && !broker.hasCurrentSession()) {
    void retireForwarding(true).catch(() => undefined);
    previewFrameAuthorizations.clear();
    broker = null;
  }
  // Persisted intent can exist from an earlier app launch even when this
  // launch never constructed a broker/coordinator. Sign-out still prunes it.
  if (previousSession && previousSession.sessionKey !== forwardingSession?.sessionKey)
    getForwardingPreferences().removeAccount(previousSession.accountId);
}
onMainAuthSessionChanged(reconcileCloudWorkspaceAccessSession);

/** Shared-store notifications must retire cloud authority before advertising
 * the replacement login to the renderer. Same-source refresh is a no-op. */
export function handleSharedCloudAccessSessionChange(notify: () => void): void {
  reconcileCloudWorkspaceAccessSession();
  notify();
}
