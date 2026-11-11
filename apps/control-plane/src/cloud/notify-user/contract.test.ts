import { beforeAll, expect, it } from "vitest";
import { CloudV2ControlFrameSchema } from "../contract.js";
import { NOTIFY_USER_FEATURE, NOTIFY_USER_KINDS, NOTIFY_USER_LIMITS, NotifyUserEventSchema, NotifyUserInputSchema, NotifyUserWorkerRequestSchema } from "./contract.js";

type Schema = { safeParse(value: unknown): { success: boolean; data?: unknown } };
let protocol: Record<string,any>, control: Schema, events: Record<string,Schema>;
beforeAll(async () => {
  const root = new URL(process.env.CLOUD_API_TEST_PROTOCOL_ROOT ?? "../../../../../packages/protocol/src/",import.meta.url);
  protocol = await import(new URL("notify-user.ts",root).href);
  control = (await import(new URL("cloud-v2-relay.ts",root).href)).CloudV2ControlFrameSchema;
  events = (await import(new URL("local-commands.ts",root).href)).LocalCommandEventSchemas;
});
const id = "11111111-1111-4111-8111-111111111111";
const input = { kind: "review", title: "Review this change", message: "Ready for you." };
const request = { ...input,notificationId: id,chatId: "chat",userMessageId: "message",executionId: "native-session" };
const event = { ...input,notificationId: id,workspace: { id,name: "workspace",title: null },chat: { id: "chat",title: "Chat" },createdAt: "2026-11-10T12:00:00.000Z" };
function parity(left: Schema, right: Schema, value: unknown, valid: boolean) {
  const a = left.safeParse(value), b = right.safeParse(value);
  expect(a.success).toBe(valid); expect(b.success).toBe(valid);
  if (valid) expect(a.data).toEqual(b.data);
}

it("mirrors the feature, bounds and kinds", () => {
  expect(NOTIFY_USER_FEATURE).toEqual(protocol.NOTIFY_USER_FEATURE);
  expect(NOTIFY_USER_KINDS).toEqual(protocol.NOTIFY_USER_KINDS);
  expect(NOTIFY_USER_LIMITS).toEqual(protocol.NOTIFY_USER_LIMITS);
});
it("mirrors strict input and the title/message character bounds", () => {
  for (const [value,valid] of [
    [input,true], [{ ...input,kind: "blocked" },true], [{ ...input,title: "x".repeat(80),message: "x".repeat(280) },true],
    [{ ...input,title: "a\n\u0000" },true], [{ ...input,kind: "info" },false], [{ ...input,mac: "injected" },false],
    ...["", " ", "x".repeat(81)].map(title => [{ ...input,title },false]),
    ...["", "\n", "x".repeat(281)].map(message => [{ ...input,message },false]),
  ] as Array<[unknown,boolean]>) parity(NotifyUserInputSchema,protocol.NotifyUserInputSchema,value,valid);
});
it("mirrors the v2 turn identity separately from the native execution", () => {
  parity(NotifyUserWorkerRequestSchema,protocol.NotifyUserWorkerRequestSchema,request,true);
  const { userMessageId: _turn,...old } = request;
  parity(NotifyUserWorkerRequestSchema,protocol.NotifyUserWorkerRequestSchema,old,false);
  for (const field of ["chatId","userMessageId","executionId"]) for (const [value,valid] of [["x".repeat(256),true],["",false],["x".repeat(257),false],["id\n",false],["id\u0000",false]] as const)
    parity(NotifyUserWorkerRequestSchema,protocol.NotifyUserWorkerRequestSchema,{ ...request,[field]: value },valid);
  parity(NotifyUserWorkerRequestSchema,protocol.NotifyUserWorkerRequestSchema,{ ...request,notificationId: "invalid" },false);
  for (const field of ["workspaceId","userId","deviceId"]) parity(NotifyUserWorkerRequestSchema,protocol.NotifyUserWorkerRequestSchema,{ ...request,[field]: id },false);
});
it("matches the desktop's named notify event without exposing the native or turn IDs", () => {
  for (const other of [protocol.NotifyUserEventSchema,events.notify!]) {
    parity(NotifyUserEventSchema,other,event,true);
    parity(NotifyUserEventSchema,other,{ ...event,workspace: { id,name: "x".repeat(120),title: "x".repeat(120) },chat: { id: "chat",title: "x".repeat(4096) } },true);
    for (const value of [{ ...event,executionId: "private" },{ ...event,userMessageId: "private" },{ ...event,createdAt: "yesterday" },
      { ...event,workspace: { ...event.workspace,name: "x".repeat(121) } },{ ...event,chat: { id: "chat",title: "x".repeat(4097) } }]) parity(NotifyUserEventSchema,other,value,false);
  }
});
it("matches optional NotifyUser configuration and still accepts an N-1 frame", () => {
  const frame = { t: "config",loginRevision: "0",agents: {},workspace: { id,organizationId: id,checkoutPath: "/home/user/example/repo",repository: "example/repo",branch: "work",baseBranch: "main" } };
  parity(CloudV2ControlFrameSchema,control,frame,true);
  for (const notifyUser of [1,0,2,true,"1",null]) parity(CloudV2ControlFrameSchema,control,{ ...frame,notifyUser },notifyUser === 1);
});
