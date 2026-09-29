import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ epoch: 1, generation: 1, readable: true, log: vi.fn() }));
vi.mock("../cloud-workspace-catalog", () => ({ cloudCatalogGeneration: () => mocks.epoch,
  cloudWorkspaceDocument: () => ({ generation: { number: mocks.generation } }), canReadCloudWorkspace: () => mocks.readable }));
vi.mock("../../platform/observability/logging/renderer-log", () => ({ logEvent: mocks.log }));
import { clearCloudLatencySpans, cloudLatencySnapshot, finishCloudFirstText, observeCloudTranscriptPaint, pruneCloudLatencySpans, startCloudNavigationSpan, startCloudSubmitSpan } from "../cloud-workspace-latency";
import { cloudScopedId } from "../../platform/bridge/cloud-workspace-key";
const target = { organizationId: "11111111-1111-4111-8111-111111111111", workspaceId: "22222222-2222-4222-8222-222222222222" };
const folder = `cloud://${target.organizationId}/${target.workspaceId}`;
const chat = cloudScopedId(target, "saved-chat");
let frames = new Map<number, FrameRequestCallback>();
let sequence = 0;
function frame() { const pending = [...frames.values()]; frames.clear(); for (const callback of pending) callback(performance.now()); }
beforeEach(() => {
  clearCloudLatencySpans(); vi.clearAllMocks(); frames = new Map(); mocks.epoch = 1; mocks.generation = 1; mocks.readable = true;
  vi.stubGlobal("document", { visibilityState: "visible" });
  vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) => { frames.set(++sequence, fn); return sequence; });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
});
afterEach(() => { clearCloudLatencySpans(); vi.unstubAllGlobals(); });
describe("cloud latency UI boundaries", () => {
  it("finishes intent and click only after the visible transcript has painted", () => {
    startCloudNavigationSpan(folder, "intent");
    startCloudNavigationSpan(folder, "click", chat);
    const stop = observeCloudTranscriptPaint(folder, chat, true);
    expect(cloudLatencySnapshot()).toEqual([]);
    frame(); expect(cloudLatencySnapshot()).toEqual([]);
    frame();
    expect(cloudLatencySnapshot().map(s => s.span)).toEqual(["intent_history_visible", "click_transcript_paint"]);
    expect(mocks.log).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(mocks.log.mock.calls)).not.toContain(folder);
    expect(JSON.stringify(mocks.log.mock.calls)).not.toContain(chat);
    stop();
  });
  it("handles clicks on an already resident active surface", () => {
    const stop = observeCloudTranscriptPaint(folder, chat, true);
    startCloudNavigationSpan(folder, "click", chat);
    frame(); frame();
    expect(cloudLatencySnapshot()).toHaveLength(1);
    stop();
  });
  it.each(["hidden", "unmounted", "generation", "account", "deleted"])("discards a paint when %s", cause => {
    startCloudNavigationSpan(folder, "click", chat);
    const stop = observeCloudTranscriptPaint(folder, chat, true);
    frame();
    if (cause === "hidden") vi.stubGlobal("document", { visibilityState: "hidden" });
    if (cause === "unmounted") stop();
    if (cause === "generation") mocks.generation++;
    if (cause === "account") mocks.epoch++;
    if (cause === "deleted") mocks.readable = false;
    pruneCloudLatencySpans(); frame();
    expect(cloudLatencySnapshot()).toEqual([]); stop();
  });
  it("records first nonempty root text, excluding thoughts, tools and a different chat", () => {
    const cancel = startCloudSubmitSpan(chat);
    finishCloudFirstText(chat, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "thought" } });
    finishCloudFirstText(chat, { sessionUpdate: "tool_call" });
    finishCloudFirstText(chat, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: " " } });
    finishCloudFirstText(chat, { sessionUpdate: "agent_message_chunk", parentToolId: "child", content: { type: "text", text: "child text" } });
    finishCloudFirstText(cloudScopedId(target, "another-chat"), { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "other text" } });
    expect(cloudLatencySnapshot()).toEqual([]);
    finishCloudFirstText(chat, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "private assistant text" } });
    expect(cloudLatencySnapshot()[0].span).toBe("submit_first_text");
    expect(JSON.stringify(mocks.log.mock.calls)).not.toContain("private assistant text");
    cancel?.();
  });
  it("keeps Local paths and cancelled submissions out of diagnostics", () => {
    startCloudNavigationSpan("/local/repo", "intent");
    expect(startCloudSubmitSpan("local-chat")).toBeUndefined();
    const cancel = startCloudSubmitSpan(chat); cancel?.();
    finishCloudFirstText(chat, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "late" } });
    expect(cloudLatencySnapshot()).toEqual([]);
  });
});
