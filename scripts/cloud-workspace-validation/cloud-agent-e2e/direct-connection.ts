import {
  CloudAgentBootConversationSchema,
  CloudAgentBootScopeSchema,
  type CloudAgentBootScope,
} from "@zeros/protocol/cloud-agent-bootstrap";
import { CloudDirectProviderConnectionTargetSchema } from "@zeros/protocol/cloud-runtime-connection";
import { BridgeClient, type BridgeClientOpts } from "../lib/bridge-client";

export class DirectConnectionFailure extends Error {
  constructor(readonly code: "direct_target_invalid" | "direct_handshake_invalid" | "direct_transport_failed") {
    super(code); this.name = "DirectConnectionFailure";
  }
}

const scopeKeys = ["organizationId", "workspaceId", "generation", "engineInstanceId", "bootId", "writerEpoch",
  "fundingOwnerUserId", "fundingOwnerEpoch"] as const;
function sameScope(left: CloudAgentBootScope, right: CloudAgentBootScope): boolean {
  return scopeKeys.every(key => left[key] === right[key]);
}

/** Operator-only direct connector. Target metadata must already have passed
 * the broker's CP/resource/actor gates. This additional check binds the actual
 * ENGINE_READY to that target before CONNECTED or workspace work. There is no
 * automatic fallback, grant reuse or operation replay in this helper.
 * The private TLS factory is a fixture seam, never an environment/CLI option. */
export async function connectDirectProvider(input: {
  target: unknown;
  expectedBootScope: CloudAgentBootScope;
  expectedAuthorityEpoch: number;
  webSocketFactory?: BridgeClientOpts["webSocketFactory"];
  connectTimeoutMs?: number;
  now?: () => number;
}): Promise<{ client: BridgeClient; evidence: {
  channel: "direct-provider-websocket"; bootBindingVerified: true;
  topology: "private-tls-routing-fixture" | "provider-websocket"; providerQualified: false;
} }> {
  const parsed = CloudDirectProviderConnectionTargetSchema.safeParse(input.target);
  const expected = CloudAgentBootScopeSchema.safeParse(input.expectedBootScope);
  const now = input.now?.() ?? Date.now();
  if (!parsed.success || !expected.success || !Number.isSafeInteger(now) ||
      parsed.data.authorityEpoch !== input.expectedAuthorityEpoch || !sameScope(parsed.data.bootScope, expected.data) ||
      parsed.data.expiresAt - now <= 5_000 || parsed.data.expiresAt - now > 16 * 60_000 ||
      input.connectTimeoutMs !== undefined && (!Number.isSafeInteger(input.connectTimeoutMs) || input.connectTimeoutMs < 100 || input.connectTimeoutMs > 30_000))
    throw new DirectConnectionFailure("direct_target_invalid");
  const target = parsed.data;
  let handshakeRejected = false, verified = false;
  const client = new BridgeClient({ url: target.url, cloudToken: target.cloudToken,
    webSocketFactory: input.webSocketFactory, connectTimeoutMs: input.connectTimeoutMs,
    verifyEngineReady: message => {
      const binding = CloudAgentBootConversationSchema.safeParse(message.cloudLocalCommands);
      const valid = binding.success && message.source === "engine" &&
        Array.isArray(message.capabilities) && message.capabilities.includes("cloud.localCommands.v1") &&
        binding.data.authorityEpoch === target.authorityEpoch && sameScope(binding.data, target.bootScope);
      handshakeRejected ||= !valid; verified = valid;
      return valid;
    } });
  try {
    await client.connect();
    if (!verified) throw new DirectConnectionFailure("direct_handshake_invalid");
    return { client, evidence: { channel: "direct-provider-websocket", bootBindingVerified: true,
      topology: input.webSocketFactory ? "private-tls-routing-fixture" : "provider-websocket", providerQualified: false } };
  } catch {
    client.close();
    throw new DirectConnectionFailure(handshakeRejected ? "direct_handshake_invalid" : "direct_transport_failed");
  }
}
