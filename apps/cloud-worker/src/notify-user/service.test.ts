import { expect, it, vi } from "vitest";
import { NotifyUserWorkerRequestSchema, type NotifyUserWorkerRequest } from "@zeros/protocol/notify-user";
import { NotifyUserService } from "./service";

const input = { title: "Ready for review", message: "The fix is ready.", kind: "review" as const };
const signal = new AbortController().signal;
function fixture(deliver?: ConstructorParameters<typeof NotifyUserService>[0]["deliver"]) {
  let turn: { chatId: string; turnId: string; executionId: string } | undefined = { chatId: "chat", turnId: "t1", executionId: "native-exec" };
  const published: unknown[] = [];
  const service = new NotifyUserService({ activeTurn: () => turn, publish: async (executionId, update) => { published.push({ executionId, ...update }); }, ...(deliver ? { deliver } : {}) });
  return { service, published, setTurn: (next: typeof turn) => { turn = next; } };
}

it("delivers once per turn with one fresh notification id for both paths, and again in the next turn", async () => {
  const deliver = vi.fn(async (_request: NotifyUserWorkerRequest, _signal: AbortSignal) => "sent" as const);
  const f = fixture(deliver);
  expect(await f.service.notify("exec", input, signal)).toBe("sent");
  const request = deliver.mock.calls[0]![0];
  // The route names the native execution, not the tool grant that called.
  expect(request).toEqual({ notificationId: expect.stringMatching(/^[0-9a-f-]{36}$/), chatId: "chat", userMessageId: "t1", executionId: "native-exec", ...input });
  expect(f.published).toEqual([{ executionId: "exec", notificationId: request.notificationId, ...input }]);
  expect(await f.service.notify("exec", input, signal)).toBe("already_notified");
  expect(deliver).toHaveBeenCalledTimes(1);
  f.setTurn({ chatId: "chat", turnId: "t2", executionId: "native-exec" });
  expect(await f.service.notify("exec", input, signal)).toBe("sent");
  expect(deliver.mock.calls[1]![0]).toMatchObject({ userMessageId: "t2" });
  expect(deliver.mock.calls[1]![0].notificationId).not.toBe(request.notificationId);
});

it("follows the server: 409 and 429 reach no app; an unreachable control plane still reaches attached apps", async () => {
  for (const [answer, published] of [["already_notified", 0], ["rate_limited", 0]] as const) {
    const f = fixture(async () => answer);
    expect(await f.service.notify("exec", input, signal)).toBe(answer);
    expect(f.published).toHaveLength(published);
  }
  const f = fixture(async () => { throw new Error("offline"); });
  expect(await f.service.notify("exec", input, signal)).toBe("unreachable");
  expect(f.published).toHaveLength(1);
});

it("needs a running turn, and never fails the turn when publishing fails", async () => {
  const f = fixture(async () => "sent");
  f.setTurn(undefined);
  expect(await f.service.notify("exec", input, signal)).toBe("no_turn");
  const failing = new NotifyUserService({ activeTurn: () => ({ chatId: "c", turnId: "t", executionId: "e" }), publish: async () => { throw new Error("closed"); }, deliver: async () => "sent" });
  expect(await failing.notify("exec", input, signal)).toBe("sent");
});

it("names the active turn's execution context in an activated workspace, so the server reaches that turn's person", async () => {
  const deliver = vi.fn(async (_request: NotifyUserWorkerRequest, _signal: AbortSignal) => "sent" as const);
  const contextId = "66666666-6666-4666-8666-666666666666";
  const service = new NotifyUserService({ activeTurn: () => ({ chatId: "chat", turnId: "t1", executionId: "native-exec", contextId }), publish: async () => {}, deliver });
  expect(await service.notify("exec", input, signal)).toBe("sent");
  expect(deliver.mock.calls[0]![0]).toMatchObject({ contextId });
  expect(NotifyUserWorkerRequestSchema.parse(deliver.mock.calls[0]![0])).toMatchObject({ contextId });
});
