import { describe, expect, it } from "vitest";
import { NotifyUserEventSchema, NotifyUserInputSchema, NotifyUserWorkerRequestSchema } from "../notify-user";
import { LocalCommandEventSchemas } from "../local-commands";
import { CloudV2ControlFrameSchema } from "../cloud-v2-relay";

const notificationId = "0f0e0d0c-0b0a-4908-8706-050403020100";
const event = { notificationId, workspace: { id: "11111111-1111-4111-8111-111111111111", name: "w-7", title: "Fix login" }, chat: { id: "chat-1", title: "Simulator" },
  kind: "review", title: "Ready for review", message: "The login fix is ready; two tests changed.", createdAt: "2026-11-10T12:00:00.000Z" };

describe("notify-user-v1 (B1 wire)", () => {
  it("bounds the tool input: title 1..80, message 1..280, a closed kind, nothing else", () => {
    expect(NotifyUserInputSchema.safeParse({ title: "x".repeat(80), message: "y".repeat(280), kind: "blocked" }).success).toBe(true);
    for (const bad of [{ title: "x".repeat(81), message: "m", kind: "review" }, { title: "t", message: "y".repeat(281), kind: "review" },
      { title: " ", message: "m", kind: "review" }, { title: "t", message: "m", kind: "fyi" }, { title: "t", message: "m", kind: "review", chatId: "c" }])
      expect(NotifyUserInputSchema.safeParse(bad).success, JSON.stringify(bad).slice(0, 60)).toBe(false);
  });
  it("adds only the notification id, the chat turn and the execution to the worker request (v2)", () => {
    const body = { notificationId, chatId: "chat-1", userMessageId: "user-1", executionId: "exec-1", kind: "review", title: "t", message: "m" };
    expect(NotifyUserWorkerRequestSchema.parse(body)).toEqual(body);
    expect(NotifyUserWorkerRequestSchema.safeParse({ ...body, notificationId: "1" }).success).toBe(false);
    expect(NotifyUserWorkerRequestSchema.safeParse({ ...body, workspaceId: "w" }).success).toBe(false);
    const { userMessageId: _turn, ...withoutTurn } = body;
    expect(NotifyUserWorkerRequestSchema.safeParse(withoutTurn).success).toBe(false);
  });
  it("carries notify on the device channel, strictly", () => {
    expect(LocalCommandEventSchemas.notify.parse(event)).toEqual(event);
    expect(NotifyUserEventSchema.safeParse({ ...event, command: "ls" }).success).toBe(false);
  });
  it("keeps the configuration flag optional and exact", () => {
    const config = CloudV2ControlFrameSchema.options.find(option => option.shape.t.value === "config") as unknown as { shape: Record<string, { safeParse(value: unknown): { success: boolean } }> };
    const flag = config.shape.notifyUser!;
    expect(flag.safeParse(undefined).success).toBe(true);
    for (const value of [1, 0, true]) expect(flag.safeParse(value).success).toBe(value === 1);
  });
});
