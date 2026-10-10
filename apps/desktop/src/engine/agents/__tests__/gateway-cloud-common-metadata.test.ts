import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentGateway } from "../gateway";
import * as cloudExecution from "../cloud-provider-execution";
import type { PreparedBoundary } from "../containment/types";
import { testExecutionBoundary } from "./helpers/test-execution-boundary";

const gateways: AgentGateway[] = [];
type GatewayOptions = ConstructorParameters<typeof AgentGateway>[0];
afterEach(async () => {
  for (const gateway of gateways.splice(0)) {
    (gateway as unknown as { executionBoundaries: Map<string, PreparedBoundary> }).executionBoundaries.clear();
    await gateway.dispose();
  }
  vi.restoreAllMocks();
});
function setup() {
  const onSessionUpdate = vi.fn(), signal = new AbortController(), legacySignal = new AbortController();
  const events: GatewayOptions["events"] = { onSessionUpdate, onPermissionRequest() {}, onQuestionRequest() {}, onAgentStderr() {}, onAgentExit() {} };
  const gateway = new AgentGateway({ projectRoot: "/tmp/zeros-common-metadata", executionBoundary: testExecutionBoundary(), events,
    cloudAgentExecutionFactory: { prepare: async () => { throw new Error("Unexpected admission in metadata fixture"); } } });
  gateways.push(gateway);
  const internal = gateway as unknown as { events: GatewayOptions["events"]; executionBoundaries: Map<string, PreparedBoundary> };
  const boundary = {} as PreparedBoundary;
  internal.executionBoundaries.set("execution", boundary);
  const confirm = vi.fn(async () => {}), publish = vi.fn(), redact = vi.fn((value: Parameters<GatewayOptions["events"]["onSessionUpdate"]>[1]) => value);
  const lease = { signal: legacySignal.signal, admission: { provider: "stale-provider" } };
  const execution = { provider: "cursor", lifetime: { signal: signal.signal }, lease,
    redactor: { notification: redact }, coordinator: { confirmHistoryBinding: confirm, recordPublication: publish } } as unknown as cloudExecution.CloudProviderExecution;
  vi.spyOn(cloudExecution, "cloudProviderExecution").mockImplementation(candidate => candidate === boundary ? execution : null);
  return { gateway, internal, signal, onSessionUpdate, confirm, publish, redact };
}
describe("gateway common immutable cloud execution metadata", () => {
  it("confirms saved native history using common provider/lifetime rather than lease admission", async () => {
    const f = setup();
    await f.gateway.confirmCloudHistoryBinding("execution", { version: 1, providerId: "cursor", kind: "native", resumeId: "native" });
    expect(f.confirm).toHaveBeenCalledOnce();
  });
  it("redacts and records publication under the common exact provider identity", () => {
    const f = setup(), notification = { sessionId: "execution", update: { sessionUpdate: "agent_message_chunk" as const,
      content: { type: "text" as const, text: "Synthetic original run" } } };
    f.internal.events.onSessionUpdate("cursor", notification);
    expect(f.redact).toHaveBeenCalledExactlyOnceWith(notification);
    expect(f.publish).toHaveBeenCalledExactlyOnceWith(notification);
    expect(f.onSessionUpdate).toHaveBeenCalledExactlyOnceWith("cursor", notification);
  });
  it("suppresses late publication after common lifetime closes even if an obsolete lease appears live", () => {
    const f = setup(); f.signal.abort();
    f.internal.events.onSessionUpdate("cursor", { sessionId: "execution", update: { sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Late old scope" } } });
    expect(f.onSessionUpdate).not.toHaveBeenCalled(); expect(f.redact).not.toHaveBeenCalled();
  });
});
