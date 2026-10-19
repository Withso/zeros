import type { Capabilities, CapabilityProofFields } from "@zeros/cloud-client";
import { CloudRuntimeConnectionTargetSchema, type CloudRuntimeConnectionTarget } from "@zeros/protocol/cloud-runtime-connection";
import { CloudSdkCapabilitiesSchema, CloudSdkRuntimeTargetSchema, type CloudSdkRuntimeIdentity, type CloudSdkRuntimeTarget, type CloudSdkTarget } from "../../../shared/cloud-sdk-contract";
import { CLOUD_SDK_COMMAND_ENVELOPE_MAX_BYTES, CloudSdkConnectionReceiptSchema } from "../../../shared/cloud-sdk-command-contract";
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
  const { organizationId, workspaceId } = target;
  return admitted(await nativeInvoke("cloud_workspace_sdk_runtime_open", { organizationId, workspaceId }), epoch);
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

export async function activateCloudSdkRuntimeConnection(target: CloudSdkRuntimeTarget, handshakeNonce: string): Promise<{ attemptId: string }> {
  const epoch = getOrganizationStoreGeneration();
  const receipt = CloudSdkConnectionReceiptSchema.parse(unwrapCloudRuntimeAccess(await nativeInvoke("cloud_workspace_sdk_runtime_connection",
    { action: "activate", runtime: cloudSdkRuntimeIdentity(target), handshakeNonce })));
  if (epoch !== getOrganizationStoreGeneration()) {
    await retireCloudSdkRuntimeConnection(target, receipt.attemptId).catch(() => false);
    assertAccount(epoch);
  }
  return receipt;
}

export async function retireCloudSdkRuntimeConnection(target: CloudSdkRuntimeTarget, attemptId: string): Promise<boolean> {
  return unwrapCloudRuntimeAccess(await nativeInvoke("cloud_workspace_sdk_runtime_connection",
    { action: "retire", runtime: cloudSdkRuntimeIdentity(target), attemptId })) === true;
}

export async function cancelCloudSdkRuntimeCommand(target: CloudSdkRuntimeTarget, attemptId: string, requestId: string): Promise<boolean> {
  return unwrapCloudRuntimeAccess(await nativeInvoke("cloud_workspace_sdk_runtime_connection",
    { action: "cancel", runtime: cloudSdkRuntimeIdentity(target), attemptId, requestId })) === true;
}

/** Native returns an entire transient send envelope. The renderer forwards
 * these bytes unchanged and never treats the response as a signing API. */
export async function prepareCloudSdkCommandEnvelope(target: CloudSdkRuntimeTarget, attemptId: string, command: string): Promise<string> {
  const epoch = getOrganizationStoreGeneration();
  const envelope = unwrapCloudRuntimeAccess<unknown>(await nativeInvoke("cloud_workspace_sdk_runtime_command",
    { runtime: cloudSdkRuntimeIdentity(target), attemptId, command }));
  assertAccount(epoch);
  if (typeof envelope !== "string" || !envelope.length || envelope.length > CLOUD_SDK_COMMAND_ENVELOPE_MAX_BYTES ||
      new TextEncoder().encode(envelope).byteLength > CLOUD_SDK_COMMAND_ENVELOPE_MAX_BYTES)
    throw new CloudRuntimeAccessError({ code: "bad_response", status: 201 });
  return envelope;
}

function assertAccount(epoch: number): void {
  if (epoch !== getOrganizationStoreGeneration()) throw new CloudRuntimeAccessError({ code: "cloud_workspace_access_superseded", status: 409 });
}
