import type { z } from "zod";
import type { CommandHandler } from "../router";
import { getCloudWorkspaceAccessBroker } from "../../cloud-workspace-access-runtime";
import { CloudSdkProofRequestSchema, CloudSdkRuntimeIdentitySchema, CloudSdkTargetSchema } from "../../../shared/cloud-sdk-contract";
import { CloudWorkspaceAccessClientError } from "../../cloud-workspace-access-client";
import { cloudRuntimeAccessErrorEnvelope } from "../../../src/renderer/platform/bridge/cloud-runtime-access-error";

function command<T>(schema: z.ZodType<T>, run: (input: T) => unknown): CommandHandler {
  return async args => {
    try {
      const parsed = schema.safeParse(args);
      if (!parsed.success) throw new CloudWorkspaceAccessClientError(422, "invalid_input", "The cloud access request is invalid");
      return await run(parsed.data);
    } catch (error) { return cloudRuntimeAccessErrorEnvelope(error); }
  };
}

export const cloudWorkspaceSdkRuntimeOpen = command(CloudSdkTargetSchema, input => getCloudWorkspaceAccessBroker().openSdkRuntime(input));
export const cloudWorkspaceSdkRuntimeRefresh = command(CloudSdkRuntimeIdentitySchema, input => getCloudWorkspaceAccessBroker().refreshSdkRuntime(input));
export const cloudWorkspaceSdkRuntimeLegacy = command(CloudSdkRuntimeIdentitySchema, input => getCloudWorkspaceAccessBroker().fallbackSdkRuntime(input));
export const cloudWorkspaceSdkRuntimeProof = command(CloudSdkProofRequestSchema, input => getCloudWorkspaceAccessBroker().signSdkRuntimeProof(input));
export const cloudWorkspaceSdkRuntimeCapabilities = command(CloudSdkRuntimeIdentitySchema, input => getCloudWorkspaceAccessBroker().renewSdkRuntimeCapabilities(input));
