import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { measureBootOwnerTurn } from "../cloud-workspace-validation/cloud-agent-e2e/baseline";
import { measureBootOwnerConversation } from "../cloud-workspace-validation/cloud-agent-e2e/conversation-measurement";

vi.mock("../cloud-workspace-validation/cloud-agent-e2e/baseline", () => ({ measureBootOwnerTurn: vi.fn() }));
beforeEach(() => vi.resetAllMocks());
const bridge = {} as Parameters<typeof measureBootOwnerTurn>[0];
function input() {
  return { conversationId: randomUUID(), userMessageId: randomUUID(), provider: "codex", prompt: "fixture prompt" } as Parameters<typeof measureBootOwnerTurn>[1];
}
function result(n: number) {
  return { turn: { commandId: randomUUID(), outcome: "pre_auth_only" },
    sendToNativeWriteIngress: { requests: [{ arrivalSequence: n }] }, sendWindow: { ingressCount: n } } as unknown as Awaited<ReturnType<typeof measureBootOwnerTurn>>;
}
describe("cold and same-conversation warm measurement", () => {
  it("uses two distinct actual sends in the same conversation with independent measured rows", async () => {
    const value = input(), first = result(1), second = result(2), observed: unknown[] = [];
    vi.mocked(measureBootOwnerTurn).mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    await measureBootOwnerConversation(bridge, value, row => { observed.push(row); });
    expect(measureBootOwnerTurn).toHaveBeenCalledTimes(2);
    const calls = vi.mocked(measureBootOwnerTurn).mock.calls;
    expect(calls[0][1]).toMatchObject({ ...value, existing: false });
    expect(calls[1][1]).toMatchObject({ conversationId: value.conversationId, provider: value.provider, prompt: value.prompt, existing: true });
    expect(calls[1][1].userMessageId).not.toBe(value.userMessageId);
    expect(observed).toEqual([{ conversationId: value.conversationId, turnKind: "cold-first", turnOrdinal: 1, measurement: first },
      { conversationId: value.conversationId, turnKind: "same-conversation-second", turnOrdinal: 2, measurement: second }]);
  });
  it("waits for the first turn and its independent final proof before starting the second", async () => {
    let resolve!: (value: Awaited<ReturnType<typeof measureBootOwnerTurn>>) => void;
    vi.mocked(measureBootOwnerTurn).mockImplementationOnce(() => new Promise(done => { resolve = done; })).mockResolvedValueOnce(result(2));
    const task = measureBootOwnerConversation(bridge, input(), () => {});
    await Promise.resolve(); expect(measureBootOwnerTurn).toHaveBeenCalledTimes(1);
    resolve(result(1)); await task; expect(measureBootOwnerTurn).toHaveBeenCalledTimes(2);
  });
  it("does not issue a second send or retry an ambiguous or rejected first turn", async () => {
    const failure = new Error("fixture first turn rejected"), observed = vi.fn();
    vi.mocked(measureBootOwnerTurn).mockRejectedValueOnce(failure);
    await expect(measureBootOwnerConversation(bridge, input(), observed)).rejects.toBe(failure);
    expect(measureBootOwnerTurn).toHaveBeenCalledTimes(1); expect(observed).not.toHaveBeenCalled();
  });
  it("retains the first row when the second turn fails, without retry or stale row reuse", async () => {
    const value = input(), first = result(1), failure = new Error("fixture second turn rejected"), observed: unknown[] = [];
    vi.mocked(measureBootOwnerTurn).mockResolvedValueOnce(first).mockRejectedValueOnce(failure);
    await expect(measureBootOwnerConversation(bridge, value, row => { observed.push(row); })).rejects.toBe(failure);
    expect(measureBootOwnerTurn).toHaveBeenCalledTimes(2);
    expect(observed).toEqual([{ conversationId: value.conversationId, turnKind: "cold-first", turnOrdinal: 1, measurement: first }]);
  });
});
