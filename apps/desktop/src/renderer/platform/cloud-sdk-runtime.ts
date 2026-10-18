import type { Capabilities, CapabilityProofFields } from "@zeros/cloud-client";
import { CloudRuntimeConnectionTargetSchema, type CloudRuntimeConnectionTarget } from "@zeros/protocol/cloud-runtime-connection";
import { CloudSdkCapabilitiesSchema, CloudSdkRuntimeTargetSchema, type CloudSdkRuntimeIdentity, type CloudSdkRuntimeTarget, type CloudSdkTarget } from "../../../shared/cloud-sdk-contract";
import { getOrganizationStoreGeneration } from "../features/team/team-store";
import { nativeInvoke } from "./runtime";
import { closeCloudWorkspaceRuntime } from "./cloud-workspace-access";
import { CloudRuntimeAccessError, unwrapCloudRuntimeAccess } from "./bridge/cloud-runtime-access-error";

export type CloudSdkRuntimeAdmission = CloudRuntimeConnectionTarget | CloudSdkRuntimeTarget;

/** Never include the connection capabilities in renderer-to-main identities. */
export function cloudSdkRuntimeIdentity(target: CloudSdkRuntimeIdentity): CloudSdkRuntimeIdentity {
  const { organizationId, workspaceId, runtimeId, generation, authorityEpoch, engineInstanceId, connectionSequence } = target;
  return { organizationId, workspaceId, runtimeId, generation, authorityEpoch, engineInstanceId, connectionSequence };
}

async function admitted(value: unknown, accountEpoch: number): Promise<CloudSdkRuntimeAdmission> {
  const raw = unwrapCloudRuntimeAccess<unknown>(value);
  const sdk = raw && typeof raw === "object" && (raw as { channel?: unknown }).channel === "sdk-websocket";
  const result = sdk ? CloudSdkRuntimeTargetSchema.parse(raw) : CloudRuntimeConnectionTargetSchema.parse(raw);
  if (accountEpoch !== getOrganizationStoreGeneration()) {
    await closeCloudWorkspaceRuntime(result.runtimeId).catch(() => false);
    throw new CloudRuntimeAccessError({ code: "cloud_workspace_access_superseded", status: 409 });
  }
  return result;
}

/** Cloud callers opt into this seam only after installing the SDK peer. */
export async function openCloudSdkWorkspaceRuntime(target: CloudSdkTarget): Promise<CloudSdkRuntimeAdmission> {
  const epoch = getOrganizationStoreGeneration();
  return admitted(await nativeInvoke("cloud_workspace_sdk_runtime_open", target), epoch);
}

export async function refreshCloudSdkWorkspaceRuntime(target: CloudSdkRuntimeTarget): Promise<CloudSdkRuntimeTarget> {
  const epoch = getOrganizationStoreGeneration();
  return CloudSdkRuntimeTargetSchema.parse(await admitted(await nativeInvoke("cloud_workspace_sdk_runtime_refresh", cloudSdkRuntimeIdentity(target)), epoch));
}

export async function fallbackCloudSdkWorkspaceRuntime(target: CloudSdkRuntimeTarget): Promise<CloudRuntimeConnectionTarget> {
  const epoch = getOrganizationStoreGeneration();
  return CloudRuntimeConnectionTargetSchema.parse(await admitted(await nativeInvoke("cloud_workspace_sdk_runtime_legacy", cloudSdkRuntimeIdentity(target)), epoch));
}

export async function signCloudSdkRuntimeProof(target: CloudSdkRuntimeTarget, fields: CapabilityProofFields): Promise<string> {
  const epoch = getOrganizationStoreGeneration();
  const signature = unwrapCloudRuntimeAccess<unknown>(await nativeInvoke("cloud_workspace_sdk_runtime_proof", { runtime: cloudSdkRuntimeIdentity(target), fields }));
  assertAccount(epoch);
  if (typeof signature !== "string" || !/^[A-Za-z0-9_-]{86}$/.test(signature)) throw new CloudRuntimeAccessError({ code: "bad_response", status: 201 });
  return signature;
}

export async function renewCloudSdkRuntimeCapabilities(target: CloudSdkRuntimeTarget): Promise<Capabilities> {
  const epoch = getOrganizationStoreGeneration();
  const capabilities = unwrapCloudRuntimeAccess<unknown>(await nativeInvoke("cloud_workspace_sdk_runtime_capabilities", cloudSdkRuntimeIdentity(target)));
  assertAccount(epoch); return CloudSdkCapabilitiesSchema.parse(capabilities);
}

function assertAccount(epoch: number): void {
  if (epoch !== getOrganizationStoreGeneration()) throw new CloudRuntimeAccessError({ code: "cloud_workspace_access_superseded", status: 409 });
}
