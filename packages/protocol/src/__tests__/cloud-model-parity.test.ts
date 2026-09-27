import { describe, expect, it } from "vitest";
import { CloudAgentExecutionAdmissionSchema } from "../cloud-agent-execution";
import { CloudQueuedPromptSchema } from "../cloud-commands";
import catalog from "../../../../catalogs/models-v1.json";

const id = "11111111-1111-4111-8111-111111111111";
describe("cloud model wire compatibility", () => {
  it.each(Object.values(catalog.families).flat().map(model => model.value))("retains the exact %s catalog model", model => {
    expect(CloudQueuedPromptSchema.parse({ agentId: "claude", userMessageId: "message", prompt: [{ type: "text", text: "test" }],
      modeRevision: 0, agentCredentialGrantId: id, model }).model).toBe(model);
    expect(CloudAgentExecutionAdmissionSchema.parse({ executionId: id, delegationId: id, provider: "claude", model,
      source: { kind: "session", actorSessionId: id } }).model).toBe(model);
  });
  it.each(["*", "claude[1m][1m]", "claude[anything]", "claude\n", "a".repeat(257), `${"a".repeat(253)}[1m]`])("rejects invalid or oversized model %j", model => {
    expect(CloudAgentExecutionAdmissionSchema.safeParse({ executionId: id, delegationId: id, provider: "claude", model,
      source: { kind: "session", actorSessionId: id } }).success).toBe(false);
  });
});
