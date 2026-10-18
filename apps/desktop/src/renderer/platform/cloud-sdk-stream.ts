import type { Capabilities } from "@zeros/cloud-client";
import { CloudSdkRuntimeIdentitySchema, type CloudSdkRuntimeIdentity } from "../../../shared/cloud-sdk-contract";
import { CloudSdkStreamCommandSchema, CloudSdkStreamEventSchema, CloudSdkStreamSnapshotSchema,
  type CloudSdkStreamCommand, type CloudSdkStreamSnapshot } from "../../../shared/cloud-sdk-stream-contract";
import { getOrganizationStoreGeneration } from "../features/team/team-store";
import { CloudRuntimeAccessError, unwrapCloudRuntimeAccess } from "./bridge/cloud-runtime-access-error";
import { nativeInvoke, nativeListen } from "./runtime";
import { cloudSdkRuntimeIdentity } from "./cloud-sdk-runtime";

export async function controlCloudSdkStream(input: CloudSdkStreamCommand): Promise<CloudSdkStreamSnapshot | boolean> {
  const epoch = getOrganizationStoreGeneration(), command = CloudSdkStreamCommandSchema.parse(input);
  const raw = unwrapCloudRuntimeAccess<unknown>(await nativeInvoke("cloud_workspace_sdk_stream", command));
  const result = typeof raw === "boolean" ? raw : CloudSdkStreamSnapshotSchema.parse(raw);
  if (epoch !== getOrganizationStoreGeneration()) {
    if (command.action === "start" && typeof result !== "boolean" && result.leaseId)
      void nativeInvoke("cloud_workspace_sdk_stream", { action: "stop", streamId: result.streamId, leaseId: result.leaseId }).catch(() => {});
    throw new CloudRuntimeAccessError({ code: "cloud_workspace_access_superseded", status: 409 });
  }
  return result;
}

/** The controller validates the full event and treats invalid or missing
 * sequences as lost observation. Account retirement is fenced even if its
 * asynchronous listener cleanup has not yet completed. */
export function listenCloudSdkStream(listener: (event: unknown) => void): Promise<() => void> {
  const epoch = getOrganizationStoreGeneration();
  return nativeListen("cloud-workspace-sdk-stream", event => {
    if (epoch === getOrganizationStoreGeneration()) listener(event);
  });
}

/** Native has already registered these exact grants with its proof signer.
 * Renderer events can renew only the descriptor that subscribed to them. */
export function subscribeCloudSdkRuntimeRenewals(runtime: CloudSdkRuntimeIdentity, listener: (capabilities: Capabilities) => void): Promise<() => void> {
  const identity = CloudSdkRuntimeIdentitySchema.parse(cloudSdkRuntimeIdentity(runtime));
  let streamId: string | undefined, sequence = -1;
  return listenCloudSdkStream(raw => {
    const parsed = CloudSdkStreamEventSchema.safeParse(raw);
    if (!parsed.success) return;
    const event = parsed.data;
    if (!event.leaseId || event.event.type !== "renewal" || event.sequence <= sequence || streamId && streamId !== event.streamId) return;
    const renewal = event.event;
    if (!Object.keys(CloudSdkRuntimeIdentitySchema.shape).every(key =>
      identity[key as keyof typeof identity] === renewal.runtime[key as keyof typeof identity])) return;
    streamId = event.streamId; sequence = event.sequence;
    listener(renewal.capabilities);
  });
}
