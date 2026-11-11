import { z } from "zod";

// The control plane deploys without @zeros/protocol. The joined parity test
// keeps this mirror aligned with local-commands.ts and the frozen wire.
export const LOCAL_COMMANDS_FEATURE = "local-commands-v1";
export const LOCAL_COMMANDS_REASON_FEATURE = "local-commands-reason-v1";
export const LOCAL_COMMAND_LIMITS = {
  commandChars: 16_384, cwdChars: 4096, textChars: 1000, reasonChars: 280, macChars: 128,
  defaultTimeoutMs: 60_000, timeoutMs: 120_000, extendedTimeoutMs: 1_800_000,
  approvalMs: 120_000, streamChars: 1_048_576, inlineChars: 32_000,
} as const;
export const LOCAL_COMMAND_OUTCOMES = ["completed", "failed", "denied", "approval_timed_out", "command_timed_out", "mac_not_connected", "no_target", "disabled", "cancelled", "interrupted"] as const;
export const LOCAL_COMMAND_FAILURE_REASONS = ["cwd_not_found", "spawn_failed"] as const;
export type LocalCommandOutcome = typeof LOCAL_COMMAND_OUTCOMES[number];
const text = (max: number) => z.string().min(1).max(max).refine(value => !value.includes("\u0000") && value.trim().length > 0);
const noC0 = (value: string) => [...value].every(character => character.charCodeAt(0) >= 32);
export const LocalCommandReasonSchema = z.string().max(LOCAL_COMMAND_LIMITS.reasonChars + 64)
  .refine(value => noC0(value) && !value.includes("\u007f") && value.trim().length > 0 && value.trim().length <= LOCAL_COMMAND_LIMITS.reasonChars);
const input = z.object({ command: text(LOCAL_COMMAND_LIMITS.commandChars), cwd: text(4096).optional(),
  description: text(1000).optional(), reason: LocalCommandReasonSchema.optional(), timeoutMs: z.number().int().min(1).max(1_800_000).optional(),
  extendedTimeoutReason: text(1000).optional(), mac: text(128).optional() }).strict();
const timeoutRule = (value: { timeoutMs?: number | undefined; extendedTimeoutReason?: string | undefined }) =>
  value.timeoutMs === undefined || value.timeoutMs <= 120_000 || value.extendedTimeoutReason !== undefined;
const timeoutMessage = { message: "A timeout above 120 s needs extendedTimeoutReason.", path: ["extendedTimeoutReason"] };
export const LocalCommandInputSchema = input.refine(timeoutRule, timeoutMessage);
// Retained N-1 envelopes keep their original bytes; notice projection omits
// an old reason outside v1.3's bounds without hiding the command itself.
export const StoredLocalCommandInputSchema = input.extend({ reason: text(1000).optional() }).refine(timeoutRule, timeoutMessage);
export type LocalCommandInput = z.infer<typeof LocalCommandInputSchema>;
const stream = z.string().max(LOCAL_COMMAND_LIMITS.streamChars).refine(value => Buffer.byteLength(value) <= 1_048_576);
const resultFields = { code: z.number().int().nullable().optional(),
  stdout: stream.optional(), stderr: stream.optional(), cwd: z.string().max(4096).optional(), timedOut: z.boolean().optional(),
  denied: z.boolean().optional(), stdoutTruncated: z.boolean().optional(), stderrTruncated: z.boolean().optional(), error: z.string().max(1000).optional(),
};
const failedRule = (value: { outcome: string; error?: string | undefined; code?: number | null | undefined }) => value.outcome !== "failed"
  || ((LOCAL_COMMAND_FAILURE_REASONS as readonly string[]).includes(value.error ?? "") && value.code === undefined);
export const LocalCommandResultSchema = z.object({ outcome: z.enum(LOCAL_COMMAND_OUTCOMES), ...resultFields,
  mac: z.string().max(128).optional(), connectedMacs: z.array(z.object({ name: z.string().min(1).max(128), isDefault: z.boolean() }).strict()).max(20).optional() }).strict()
  .refine(failedRule).refine(value => value.connectedMacs === undefined || value.outcome === "no_target" || value.outcome === "mac_not_connected");
export type LocalCommandResult = z.infer<typeof LocalCommandResultSchema>;
export const LocalMacResultSchema = z.object({ ...resultFields,
  outcome: z.enum(["completed", "failed", "denied", "approval_timed_out", "command_timed_out", "cancelled", "interrupted"]),
}).strict().refine(failedRule);
export const LocalCommandIdSchema = z.string().min(1).max(256).refine(noC0);
export const LocalDeviceBindingSchema = z.object({ deviceId: z.string().uuid(), registrationId: z.string().uuid(), instanceId: z.string().uuid() }).strict();
export type LocalDeviceBinding = z.infer<typeof LocalDeviceBindingSchema>;
export const LocalDeviceRegistrationSchema = z.object({ requestId: z.string().uuid(),
  name: z.string().min(1).max(128).refine(value => noC0(value) && !value.includes("\u007f") && value.trim() === value),
  capabilities: z.union([z.tuple([z.literal(LOCAL_COMMANDS_FEATURE)]),
    z.tuple([z.literal(LOCAL_COMMANDS_FEATURE), z.literal(LOCAL_COMMANDS_REASON_FEATURE)])]),
}).strict();
export type LocalDeviceRegistration = z.infer<typeof LocalDeviceRegistrationSchema>;
export type LocalDevice = LocalDeviceBinding & { name: string; capabilities: LocalDeviceRegistration["capabilities"] };
export type LocalDevicePresence = { presenceRequired: boolean; reachableUntil: string | null };
export type ConnectedMac = { deviceId: string; name: string; connected: boolean; active: boolean; reachable: boolean; expiresAt: string | null; syncing?: boolean };
export type LocalCommandReceipt = { requestId: string; state: "pending" | "claimed" | "terminal"; approvalDeadline: string;
  runDeadline: string | null; mac: string | null; result: LocalCommandResult | null; outputAvailable: boolean };
export type LocalCommandNotice = { requestId: string; state: "terminal"; outcome: LocalCommandOutcome } | {
  requestId: string; state: "pending" | "claimed"; workspace: { id: string; name: string; title: string | null };
  chat: { id: string; title: string }; input: LocalCommandInput; mac: string; defaultMac: string | null; isDefaultTarget: boolean;
  createdAt: string; approvalDeadline: string; runDeadline: string | null;
};
export const LOCAL_DEVICE_HEADERS = ["x-zeros-device-id", "x-zeros-device-registration", "x-zeros-device-instance"] as const;
