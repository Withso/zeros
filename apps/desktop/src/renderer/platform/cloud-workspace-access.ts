import { nativeInvoke } from "./runtime";
import { z } from "zod";
import { getOrganizationStoreGeneration } from "../features/team/team-store";
import { cloudServiceAccessCache, cloudServiceContextCache } from "../state/read-caches";
import { isCloudWorkspace } from "./bridge/cloud-workspace-key";
import type {
  CloudRuntimeConnectionTarget,
  RuntimeConnectionTarget,
} from "./bridge/ws-client";

export type CloudWorkspaceAccessTarget = {
  organizationId: string;
  workspaceId: string;
};

const serviceContextSchema = z.object({ authorityId: z.string().uuid(), deviceId: z.string().uuid().nullable(), keyVersion: z.number().int().positive().nullable() }).strict();
const serviceRowsSchema = z.array(z.object({
  accessId: z.string().uuid(), kind: z.enum(["ssh", "tunnel"]), generation: z.number().int().positive(), expiresAt: z.string().datetime(),
  localPort: z.number().int().min(1024).max(65535).nullable(), remotePort: z.number().int().min(1024).max(65535).nullable(), closing: z.boolean(),
}).strict()).max(64);
export type CloudServiceContext = z.infer<typeof serviceContextSchema>;
export type CloudServiceAccessRow = z.infer<typeof serviceRowsSchema>[number];
export const cloudServiceContextKey = () => String(getOrganizationStoreGeneration());
export const cloudServiceAccessKey = (target: CloudWorkspaceAccessTarget, context: CloudServiceContext) =>
  JSON.stringify([getOrganizationStoreGeneration(), context.authorityId, context.deviceId, context.keyVersion, target.organizationId, target.workspaceId]);

export async function readCloudServiceContext(key: string): Promise<CloudServiceContext> {
  if (key !== cloudServiceContextKey()) throw new Error("The cloud access account changed.");
  const result = serviceContextSchema.parse(await nativeInvoke("cloud_workspace_access_context", {}));
  if (key !== cloudServiceContextKey()) throw new Error("The cloud access account changed.");
  const previous = cloudServiceContextCache.peekSnapshot(key).data;
  if (previous && JSON.stringify(previous) !== JSON.stringify(result)) cloudServiceAccessCache.clear();
  return result;
}

export async function readCloudServiceAccess(key: string): Promise<CloudServiceAccessRow[]> {
  const [epoch, authorityId, deviceId, keyVersion, organizationId, workspaceId] = JSON.parse(key) as [number, string, string | null, number | null, string, string];
  const assertCurrent = () => {
    const current = cloudServiceContextCache.peekSnapshot(String(epoch)).data;
    if (epoch !== getOrganizationStoreGeneration() || !current || current.authorityId !== authorityId || current.deviceId !== deviceId || current.keyVersion !== keyVersion)
      throw new Error("The cloud access account or device authority changed.");
  };
  assertCurrent();
  const result = serviceRowsSchema.parse(await nativeInvoke("cloud_workspace_access_list", { organizationId, workspaceId, authorityId, deviceId, keyVersion }));
  assertCurrent();
  return result;
}

/** Pointer/focus intent only warms local metadata; neither read issues access. */
export async function warmCloudServiceAccess(target: CloudWorkspaceAccessTarget): Promise<void> {
  if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
  const contextKey = cloudServiceContextKey();
  const context = await cloudServiceContextCache.load(contextKey, () => readCloudServiceContext(contextKey), { maxAgeMs: 5_000 });
  const key = cloudServiceAccessKey(target, context);
  await cloudServiceAccessCache.load(key, () => readCloudServiceAccess(key), { maxAgeMs: 5_000 });
}

export function invalidateCloudServiceAccess(target: CloudWorkspaceAccessTarget): void {
  cloudServiceContextCache.invalidate(cloudServiceContextKey());
  for (const key of cloudServiceAccessCache.keys()) {
    const parts = JSON.parse(key) as unknown[];
    if (parts[0] === getOrganizationStoreGeneration() && parts[4] === target.organizationId && parts[5] === target.workspaceId) cloudServiceAccessCache.invalidate(key);
  }
}

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
  target: CloudWorkspaceAccessTarget & Partial<CloudServiceContext>,
): Promise<CloudWorkspaceAccessReceipt> {
  return nativeInvoke("cloud_workspace_ssh_copy", target);
}

export function openCloudWorkspaceTerminal(
  target: CloudWorkspaceAccessTarget & Partial<CloudServiceContext>,
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
  target: CloudWorkspaceAccessTarget & Partial<CloudServiceContext> & {
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
