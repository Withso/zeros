import { nativeInvoke } from "./runtime";
import { isCloudWorkspace } from "./bridge/cloud-workspace-key";
import type {
  CloudRuntimeConnectionTarget,
  RuntimeConnectionTarget,
} from "./bridge/ws-client";

export type CloudWorkspaceAccessTarget = {
  organizationId: string;
  workspaceId: string;
};

export function cloudWorkspacePreviewsConfigured(): boolean {
  const raw = import.meta.env.VITE_CLOUD_WORKSPACE_PREVIEW_HOST_SUFFIXES;
  if (!raw?.trim() || raw.length > 8 * 254) return false;
  const suffixes = raw.split(",").map((suffix) => suffix.trim());
  return suffixes.length <= 8 && new Set(suffixes).size === suffixes.length && suffixes.every((suffix) =>
    suffix.includes(".") && suffix === suffix.toLowerCase() && !/^(?:\d{1,3}\.){3}\d{1,3}$/.test(suffix) && /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(suffix),
  );
}

export function workspacePreviewAvailable(folder: string): boolean {
  return !isCloudWorkspace(folder) || cloudWorkspacePreviewsConfigured();
}

export function cloudWorkspaceCapability(): Promise<{ enabled: boolean }> {
  return nativeInvoke("cloud_workspace_capability", {});
}

export type CloudWorkspaceAccessReceipt = {
  accessId: string;
  expiresAt: string;
};

export function copyCloudWorkspaceSshCommand(
  target: CloudWorkspaceAccessTarget,
): Promise<CloudWorkspaceAccessReceipt> {
  return nativeInvoke("cloud_workspace_ssh_copy", target);
}

export function openCloudWorkspaceTerminal(
  target: CloudWorkspaceAccessTarget,
): Promise<CloudWorkspaceAccessReceipt> {
  return nativeInvoke("cloud_workspace_ssh_terminal", target);
}

export function openCloudWorkspaceIde(
  target: CloudWorkspaceAccessTarget,
  appId: "cursor" | "vscode",
): Promise<CloudWorkspaceAccessReceipt> {
  return nativeInvoke("cloud_workspace_ssh_ide", { ...target, appId });
}

export function startCloudWorkspaceTunnel(
  target: CloudWorkspaceAccessTarget & {
    remotePort: number;
    localPort: number;
  },
): Promise<
  CloudWorkspaceAccessReceipt & {
    localHost: "127.0.0.1";
    localPort: number;
    remotePort: number;
  }
> {
  return nativeInvoke("cloud_workspace_tunnel_start", target);
}

export function revokeCloudWorkspaceAccess(accessId: string): Promise<boolean> {
  return nativeInvoke("cloud_workspace_access_revoke", { accessId });
}

export function openCloudWorkspaceRuntime(
  target: CloudWorkspaceAccessTarget,
): Promise<CloudRuntimeConnectionTarget> {
  return nativeInvoke("cloud_workspace_runtime_open", target);
}

export function refreshCloudWorkspaceRuntime(
  target: CloudRuntimeConnectionTarget,
): Promise<RuntimeConnectionTarget> {
  return nativeInvoke("cloud_workspace_runtime_refresh", {
    runtimeId: target.runtimeId,
    organizationId: target.organizationId,
    workspaceId: target.workspaceId,
    generation: target.generation,
    authorityEpoch: target.authorityEpoch,
    engineInstanceId: target.engineInstanceId,
    connectionSequence: target.connectionSequence,
  });
}

export function closeCloudWorkspaceRuntime(
  runtimeId: string,
): Promise<boolean> {
  return nativeInvoke("cloud_workspace_runtime_close", { runtimeId });
}

/** Mint and install an authenticated preview directly into one Browser iframe.
 * The returned navigation URL is bearer-free; Electron main injects the
 * capability only for requests whose frame ancestry contains `frameName`. */
export function openCloudWorkspacePreview(
  target: CloudWorkspaceAccessTarget & {
    port: number;
    frameName: string;
  },
): Promise<
  CloudWorkspaceAccessReceipt & {
    logicalUrl: string;
    origin: string;
    admissionUrl: string;
  }
> {
  if (!cloudWorkspacePreviewsConfigured()) return Promise.reject(new Error("Cloud workspace preview URLs are not configured for this build"));
  return nativeInvoke("browser:open-cloud-preview", target);
}
