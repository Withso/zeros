import type { z } from "zod";
import type { CommandHandler } from "../router";
import { getCloudWorkspaceAccessBroker } from "../../cloud-workspace-access-runtime";
import { CloudSdkProofRequestSchema, CloudSdkRuntimeIdentitySchema, CloudSdkTargetSchema } from "../../../shared/cloud-sdk-contract";
import { CloudSdkStreamCommandSchema } from "../../../shared/cloud-sdk-stream-contract";
import { CloudSdkCommandEnvelopeRequestSchema, CloudSdkConnectionControlSchema } from "../../../shared/cloud-sdk-command-contract";
import { CloudWorkspaceAccessClientError } from "../../cloud-workspace-access-client";
import { cloudRuntimeAccessErrorEnvelope } from "../../../src/renderer/platform/bridge/cloud-runtime-access-error";

function command<T>(schema: z.ZodType<T>, run: (input: T, event: Parameters<CommandHandler>[1]) => unknown): CommandHandler {
  return async (args, event) => {
    try {
      const parsed = schema.safeParse(args);
      if (!parsed.success) throw new CloudWorkspaceAccessClientError(422, "invalid_input", "The cloud access request is invalid");
      return await run(parsed.data, event);
    } catch (error) { return cloudRuntimeAccessErrorEnvelope(error); }
  };
}

export const cloudWorkspaceSdkRuntimeOpen = command(CloudSdkTargetSchema, input => getCloudWorkspaceAccessBroker().openSdkRuntime(input));
export const cloudWorkspaceSdkRuntimeRefresh = command(CloudSdkRuntimeIdentitySchema, input => getCloudWorkspaceAccessBroker().refreshSdkRuntime(input));
export const cloudWorkspaceSdkRuntimeLegacy = command(CloudSdkRuntimeIdentitySchema, input => getCloudWorkspaceAccessBroker().fallbackSdkRuntime(input));
export const cloudWorkspaceSdkRuntimeProof = command(CloudSdkProofRequestSchema, input => getCloudWorkspaceAccessBroker().signSdkRuntimeProof(input));
export const cloudWorkspaceSdkRuntimeCapabilities = command(CloudSdkRuntimeIdentitySchema, input => getCloudWorkspaceAccessBroker().renewSdkRuntimeCapabilities(input));
export const cloudWorkspaceSdkRuntimeConnection = command(CloudSdkConnectionControlSchema, (input, event) =>
  getCloudWorkspaceAccessBroker().controlSdkRuntimeConnection(input, input.action === "activate" ? onGone => {
    event.sender.once("destroyed", onGone);
    return () => { event.sender.removeListener("destroyed", onGone); };
  } : undefined));
export const cloudWorkspaceSdkRuntimeCommand = command(CloudSdkCommandEnvelopeRequestSchema, input => getCloudWorkspaceAccessBroker().prepareSdkCommandEnvelope(input));
export const cloudWorkspaceSdkStream = command(CloudSdkStreamCommandSchema, (input, event) =>
  getCloudWorkspaceAccessBroker().controlSdkStream(input, input.action === "start" ? onGone => {
    event.sender.once("destroyed", onGone);
    return () => { event.sender.removeListener("destroyed", onGone); };
  } : undefined));
