import { nativeInvoke } from "./runtime";

export type CloudWorkspaceAccessTarget = {
  organizationId: string;
  workspaceId: string;
};

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
  return nativeInvoke("browser:open-cloud-preview", target);
}
