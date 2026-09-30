import { describe, expect, it } from "vitest";
import { CloudCommandMutationSchema, CloudQueuedPromptSchema } from "../cloud-commands";
const commandId = "22222222-2222-4222-8222-222222222222";
const payload = { agentId: "codex", userMessageId: "message", prompt: [{ type: "text", text: "" }], modeRevision: 0, model: "qualified-model", agentCredentialGrantId: commandId };
describe("versioned cloud native commands", () => {
  it("accepts a durable fork with explicit source and destination", () => {
    const mutation = { conversationId: "destination", operationId: commandId, expectedRevision: 0,
      action: { kind: "fork", commandId, payload: { ...payload, operation: { version: 1, kind: "fork", sourceConversationId: "source", strategy: "native" } } } };
    expect(CloudCommandMutationSchema.parse(mutation)).toEqual(mutation);
    expect(CloudCommandMutationSchema.safeParse({ ...mutation, conversationId: "source" }).success).toBe(false);
  });
  it.each(["get", "clear", "set"])("accepts typed goal %s", action => {
    const input = { ...payload, operation: { version: 1, kind: "goal", action, ...(action === "set" ? { update: { objective: "Finish the task" } } : {}) } };
    expect(CloudQueuedPromptSchema.parse(input)).toEqual(input);
    expect(CloudQueuedPromptSchema.safeParse({ ...input, agentId: "claude" }).success).toBe(false);
  });
});
