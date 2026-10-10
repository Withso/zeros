import { CloudAgentBootConversationSchema, CloudAgentBootScopeSchema,
  type CloudAgentBootConversation } from "@zeros/protocol/cloud-agent-bootstrap";
import { CloudBootCommandClientRequestSchema } from "@zeros/protocol/cloud-commands";
import { HarnessFailure } from "./assertions";

const scopeKeys = ["organizationId", "workspaceId", "generation", "engineInstanceId", "bootId", "writerEpoch",
  "fundingOwnerUserId", "fundingOwnerEpoch"] as const;
export function sameBootMeasurementBinding(value: unknown, expected: CloudAgentBootConversation): boolean {
  const parsed = CloudAgentBootConversationSchema.safeParse(value);
  return parsed.success && parsed.data.authorityEpoch === expected.authorityEpoch &&
    scopeKeys.every(key => parsed.data[key] === expected[key]);
}

/** Actual admitted socket metadata plus independent fixture CP activation.
 * Parsing never creates negotiation, actor authority or native readiness. */
export function requireBootMeasurementBinding(ready: unknown, authority: {
  negotiated: boolean; activated: boolean; scope: unknown; authorityEpoch: number;
}): CloudAgentBootConversation {
  const message = ready && typeof ready === "object" ? ready as Record<string, unknown> : {};
  const scope = CloudAgentBootScopeSchema.safeParse(authority.scope);
  const binding = CloudAgentBootConversationSchema.safeParse(message.cloudLocalCommands);
  if (!authority.negotiated || !authority.activated || !scope.success || !binding.success ||
      message.type !== "ENGINE_READY" || message.source !== "engine" ||
      !Array.isArray(message.capabilities) || !message.capabilities.includes("cloud.localCommands.v1") ||
      !message.capabilities.includes("cloud.turnTimings.v1") || binding.data.authorityEpoch !== authority.authorityEpoch ||
      scopeKeys.some(key => binding.data[key] !== scope.data[key])) throw new HarnessFailure("fixture_contract_invalid");
  return binding.data;
}

export function bootMeasurementCommandRequest(request: unknown, binding: CloudAgentBootConversation) {
  const parsed = CloudAgentBootConversationSchema.parse(binding);
  return { nativeCommandsVersion: 1, cloudTurnProtocolVersion: 1, cloudLocalCommandsVersion: 1,
    bootId: parsed.bootId, writerEpoch: parsed.writerEpoch, request: CloudBootCommandClientRequestSchema.parse(request) };
}
