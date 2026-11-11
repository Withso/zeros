import { beforeAll, expect, it } from "vitest";
import { LOCAL_COMMANDS_FEATURE, LOCAL_COMMANDS_REASON_FEATURE, LOCAL_COMMAND_FAILURE_REASONS, LOCAL_COMMAND_LIMITS, LOCAL_COMMAND_OUTCOMES, LOCAL_DEVICE_HEADERS,
  LocalCommandInputSchema, LocalCommandResultSchema, LocalMacResultSchema, LocalDeviceRegistrationSchema } from "./contract.js";
import { NewLocalCommandSchema } from "./requests.js";
import { CloudV2ControlFrameSchema } from "../contract.js";

type Schema = { safeParse(value: unknown): { success: boolean; data?: unknown } };
let protocol: Record<string, any>;
let control: Schema;
beforeAll(async () => {
  // Isolated CP worktrees use the worker's actual source before integration;
  // no production import couples the standalone deployments.
  const root = new URL(process.env.CLOUD_API_TEST_PROTOCOL_ROOT ?? "../../../../../packages/protocol/src/",import.meta.url);
  protocol = await import(new URL("local-commands.ts",root).href);
  control = (await import(new URL("cloud-v2-relay.ts",root).href)).CloudV2ControlFrameSchema;
});
it("mirrors the optional top-level configuration field without changing N-1 frames", () => {
  const frame = { t: "config",loginRevision: "1",agents: {},workspace: { id: "11111111-1111-4111-8111-111111111111",
    organizationId: "22222222-2222-4222-8222-222222222222",checkoutPath: "/home/user/example/repo",repository: "example/repo",branch: "work",baseBranch: "main" } };
  parity(CloudV2ControlFrameSchema,control,frame,true);
  for (const localCommands of [1,0,2,true]) parity(CloudV2ControlFrameSchema,control,{ ...frame,localCommands },localCommands === 1);
  for (const localCommandReason of [1,0,2,true]) parity(CloudV2ControlFrameSchema,control,{ ...frame,localCommandReason },localCommandReason === 1);
});
function parity(left: Schema, right: Schema, value: unknown, valid: boolean) {
  const a = left.safeParse(value), b = right.safeParse(value);
  expect(a.success).toBe(valid); expect(b.success).toBe(valid);
  if (valid) expect(a.data).toEqual(b.data);
}
it("matches feature, limits, outcomes, closed failure reasons and device headers", () => {
  expect(LOCAL_COMMANDS_FEATURE).toEqual(protocol.LOCAL_COMMANDS_FEATURE);
  expect(LOCAL_COMMANDS_REASON_FEATURE).toEqual(protocol.LOCAL_COMMANDS_REASON_FEATURE);
  expect(LOCAL_COMMAND_LIMITS).toEqual(protocol.LOCAL_COMMAND_LIMITS);
  expect(LOCAL_COMMAND_OUTCOMES).toEqual(protocol.LOCAL_COMMAND_OUTCOMES);
  expect(LOCAL_COMMAND_FAILURE_REASONS).toEqual(protocol.LOCAL_COMMAND_FAILURE_REASONS);
  expect(LOCAL_DEVICE_HEADERS).toEqual(Object.values(protocol.LOCAL_COMMAND_DEVICE_HEADERS).map(value => String(value).toLowerCase()));
});
it("matches command bounds, strict input, whitespace and extended timeout admission", () => {
  const examples: Array<[unknown,boolean]> = [
    [{ command: "printf hello" },true], [{ command: "line1\nline2",cwd: "../repo",mac: "My Mac" },true],
    [{ command: "x".repeat(16384),timeoutMs: 120000 },true], [{ command: "x",timeoutMs: 1800000,extendedTimeoutReason: "Long build" },true],
    [{ command: "x",timeoutMs: 120001 },false], [{ command: "x",timeoutMs: 1800001,extendedTimeoutReason: "Long build" },false],
    ...["", " ", "x\u0000", "x".repeat(16385)].map(command => [{ command },false] as [unknown,boolean]),
    ...["cwd","mac","description","reason","extendedTimeoutReason"].map(field => [{ command: "x",[field]: " " },false] as [unknown,boolean]),
    [{ command: "x",userId: "caller-selected" },false],
  ];
  for (const [input,valid] of examples) parity(LocalCommandInputSchema,protocol.LocalCommandInputSchema,input,valid);
});
it("matches v1.3 reason bounds without rewriting bytes used by idempotency", () => {
  for (const [reason,valid] of [["why this Mac",true],["x".repeat(280),true],[` ${"x".repeat(280)} `,true],
    [" ".repeat(64)+"x".repeat(280),true],[" ".repeat(65)+"x".repeat(280),false],["x".repeat(281),false],
    ["",false],[" ",false],["why\nlocal",false],["\twhy",false],["why\u0000local",false],["why\u007f",false],[null,false],[1,false]] as const) {
    parity(LocalCommandInputSchema,protocol.LocalCommandInputSchema,{ command: "x",reason },valid);
  }
});
it("matches worker IDs including control characters at the end", () => {
  const base = { requestId: "11111111-1111-4111-8111-111111111111",chatId: "chat",executionId: "execution",input: { command: "x" } };
  for (const [id,valid] of [["chat",true],["x".repeat(256),true],["",false],["x".repeat(257),false],
    ["chat\n",false],["chat\r",false],["chat\u0000",false]] as const) {
    parity(NewLocalCommandSchema,protocol.LocalCommandWorkerCreateSchema,{ ...base,chatId: id },valid);
    parity(NewLocalCommandSchema,protocol.LocalCommandWorkerCreateSchema,{ ...base,executionId: id },valid);
  }
});
it("matches registration and rejects injected identities and untrimmed names", () => {
  const base = { requestId: "11111111-1111-4111-8111-111111111111",name: "My Mac",capabilities: [LOCAL_COMMANDS_FEATURE] };
  for (const name of ["My Mac","x".repeat(128),"", " My Mac", "My Mac\n", "x".repeat(129),"bad\u007f"]) {
    const valid = name === "My Mac" || name === "x".repeat(128);
    parity(LocalDeviceRegistrationSchema,protocol.LocalCommandRegistrationRequestSchema,{ ...base,name },valid);
  }
  parity(LocalDeviceRegistrationSchema,protocol.LocalCommandRegistrationRequestSchema,{ ...base,instanceId: base.requestId },false);
  for (const [capabilities,valid] of [
    [[LOCAL_COMMANDS_FEATURE,LOCAL_COMMANDS_REASON_FEATURE],true],[[LOCAL_COMMANDS_REASON_FEATURE],false],
    [[LOCAL_COMMANDS_REASON_FEATURE,LOCAL_COMMANDS_FEATURE],false],[[LOCAL_COMMANDS_FEATURE,LOCAL_COMMANDS_FEATURE],false],
    [[LOCAL_COMMANDS_FEATURE,"local-commands-reason-v10"],false],
  ] as Array<[unknown,boolean]>) parity(LocalDeviceRegistrationSchema,protocol.LocalCommandRegistrationRequestSchema,{ ...base,capabilities },valid);
});
it("matches UTF-8 result limits, failed receipts and names-only recovery hints", () => {
  for (const [result,valid] of [
    [{ outcome: "completed",code: 0,stdout: "\u0000".repeat(1048576) },true],
    [{ outcome: "completed",stdout: "é".repeat(524289) },false],
    [{ outcome: "failed",error: "spawn_failed" },true], [{ outcome: "failed",error: "cwd_not_found",code: null },false],
    [{ outcome: "failed",error: "private path" },false], [{ outcome: "failed" },false],
    [{ outcome: "no_target",connectedMacs: [{ name: "My Mac",isDefault: false }] },true],
    [{ outcome: "no_target",connectedMacs: [{ name: "My Mac",isDefault: false,deviceId: "foreign" }] },false],
    [{ outcome: "completed",connectedMacs: [] },false], [{ outcome: "no_target",connectedMacs: Array(21).fill({ name: "My Mac",isDefault: false }) },false],
  ] as Array<[unknown,boolean]>) parity(LocalCommandResultSchema,protocol.LocalCommandResultSchema,result,valid);
  for (const outcome of LOCAL_COMMAND_OUTCOMES) {
    const allowed = !["no_target","mac_not_connected","disabled"].includes(outcome);
    parity(LocalMacResultSchema,protocol.LocalCommandMacResultSchema,{ outcome,...(outcome === "failed" ? { error: "spawn_failed" } : {}) },allowed);
  }
  parity(LocalMacResultSchema,protocol.LocalCommandMacResultSchema,{ outcome: "completed",mac: "caller-selected" },false);
});
