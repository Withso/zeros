import { describe, expect, it } from "vitest";
import { CloudAgentTurnRequestOriginSchema, encodeCloudAgentTurnRequestOrigin,
  parseCloudAgentTurnRequestOriginHeader, CLOUD_AGENT_TURN_ORIGIN_HEADER } from "../cloud-events";

const uuid = (n: number) => `${String(n).padStart(8, "0")}-1111-4111-8111-111111111111`;
const base = () => ({ version: 1, organizationId: uuid(1), workspaceId: uuid(2), generation: 3, engineInstanceId: uuid(4),
  mode: "legacy", bootId: null, writerEpoch: null, clockId: uuid(5), spanId: uuid(6), flightId: null,
  producer: "foreground", operation: "commands.mutate", intent: { kind: "command", commandId: uuid(7),
    conversationId: "chat", turnId: "turn", executionId: null } });

describe("passive exact engine HTTP request origin", () => {
  it("retains exact legacy command/span ownership and a nullable early execution", () => {
    expect(CloudAgentTurnRequestOriginSchema.parse(base())).toEqual(base());
    expect(CLOUD_AGENT_TURN_ORIGIN_HEADER).toBe("x-zeros-agent-turn-origin");
  });
  it("keeps producer separate from operation and binds negotiated boot/writer UUIDs", () => {
    const value = { ...base(), mode: "boot-owner-v1", bootId: uuid(8), writerEpoch: uuid(9), flightId: uuid(10),
      producer: "background", operation: "credentials.validate", intent: { kind: "none" } };
    expect(CloudAgentTurnRequestOriginSchema.parse(value)).toEqual(value);
  });
  it("does not invent a command or claim identity before the actual claim response", () => {
    const value = { ...base(), producer: "unknown", operation: "commands.claim",
      intent: { kind: "claim", claimId: null, conversationId: "chat", executionId: "execution" } };
    expect(CloudAgentTurnRequestOriginSchema.parse(value)).toEqual(value);
    expect(CloudAgentTurnRequestOriginSchema.safeParse({ ...value, intent: { ...value.intent, commandId: uuid(7) } }).success).toBe(false);
  });
  it.each(["credential", "prompt", "timestamp", "headers", "path"])("rejects private/untrusted extra %s fields", field => {
    expect(CloudAgentTurnRequestOriginSchema.safeParse({ ...base(), [field]: "synthetic private value" }).success).toBe(false);
  });
  it("refuses invalid scope, closed labels, and mixed legacy/boot authority", () => {
    for (const extra of [{ writerEpoch: "42" }, { generation: 0 }, { operation: "other" }, { producer: "scheduled" },
      { bootId: uuid(8) }, { mode: "boot-owner-v1" }, { flightId: "caller-selected-label" }])
      expect(CloudAgentTurnRequestOriginSchema.safeParse({ ...base(), ...extra }).success).toBe(false);
  });
  it("encodes one strict canonical bounded header and refuses malformed/oversized/alternate encodings", () => {
    const value = CloudAgentTurnRequestOriginSchema.parse(base()), encoded = encodeCloudAgentTurnRequestOrigin(value);
    expect(parseCloudAgentTurnRequestOriginHeader(encoded)).toEqual(value);
    for (const raw of [undefined, "", "[]", "{", ` ${encoded}`, encoded.replace('"version":1', '"version": 1'), "x".repeat(2049)])
      expect(parseCloudAgentTurnRequestOriginHeader(raw)).toBeNull();
  });
});
