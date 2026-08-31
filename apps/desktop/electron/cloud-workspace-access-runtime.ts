import { app, clipboard } from "electron";
import path from "node:path";

import { CloudWorkspaceAccessBroker } from "./cloud-workspace-access-broker";
import { CloudWorkspaceAccessClient } from "./cloud-workspace-access-client";
import { CloudWorkspaceSshRuntime } from "./cloud-workspace-ssh-runtime";
import { ensureCloudAccessDeviceForMain } from "./cloud-replica-host-runtime";
import { previewFrameAuthorizations } from "./preview-frame-authorizations";
import {
  getValidAccessTokenForMain,
  onMainAuthSessionChanged,
} from "./ipc/commands/auth-session";
import { IS_DEV } from "./runtime-mode";

declare const __ZEROS_CONTROL_PLANE_URL_BAKED__: string | undefined;
declare const __ZEROS_CLOUD_PREVIEW_HOST_SUFFIXES_BAKED__: string | undefined;
declare const __ZEROS_CLOUD_SSH_KNOWN_HOSTS_B64_BAKED__: string | undefined;

let broker: CloudWorkspaceAccessBroker | null = null;

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
  if (broker) return broker;
  const hosts = allowedSshHosts();
  const knownHostEntries = pinnedSshKnownHostEntries();
  const previewHostSuffixes = allowedPreviewHostSuffixes();
  const ssh = new CloudWorkspaceSshRuntime({
    runtimeRoot: path.join(app.getPath("sessionData"), "cloud-ssh"),
    knownHostsPath: path.join(app.getPath("userData"), "cloud-ssh-known-hosts"),
    ...(hosts ? { allowedSshHosts: hosts } : {}),
    ...(knownHostEntries ? { knownHostEntries } : {}),
    allowTrustOnFirstUse: !knownHostEntries && allowSshTrustOnFirstUse(),
  });
  broker = new CloudWorkspaceAccessBroker({
    api: new CloudWorkspaceAccessClient({
      baseUrl: controlPlaneBaseUrl(),
      allowInsecureLoopback: IS_DEV,
      ...(hosts ? { allowedSshHosts: hosts } : {}),
      ...(previewHostSuffixes
        ? { allowedPreviewHostSuffixes: previewHostSuffixes }
        : {}),
    }),
    getAccessToken: getValidAccessTokenForMain,
    getDeviceId: async () =>
      (await ensureCloudAccessDeviceForMain()).deviceId,
    writeClipboard: (value) => clipboard.writeText(value),
    launchTerminal: (input) => ssh.launchTerminal(input),
    launchIde: (input) => ssh.launchIde(input),
    startTunnel: (input) => ssh.startTunnel(input),
    startDynamicTunnel: (input) => ssh.startDynamicTunnel(input),
    disposeLocalAccess: () => ssh.dispose(),
  });
  return broker;
}

export async function disposeCloudWorkspaceAccessBroker(): Promise<void> {
  previewFrameAuthorizations.clear();
  const current = broker;
  broker = null;
  await current?.dispose();
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
onMainAuthSessionChanged(disposeCloudWorkspaceAccessBroker);
