import { z } from "zod";
import { NotifyUserEventSchema } from "./notify-user";

// RunLocalCommand: a cloud agent runs one shell command on the Mac of the
// person who asked. Shared by the worker (tool), the desktop (runner and
// approval) and mirrored by the control plane. The worker <-> control plane
// request and result transport is defined with the control plane's design.

export const LOCAL_COMMANDS_FEATURE = "local-commands-v1";
export const LOCAL_COMMAND_LIMITS = {
  commandChars: 16_384, cwdChars: 4096, textChars: 1000, macChars: 128,
  defaultTimeoutMs: 60_000, timeoutMs: 120_000, extendedTimeoutMs: 1_800_000,
  /** Waiting for the person's decision, on top of the command's own timeout. */
  approvalMs: 120_000,
  /** Each stream is capped on the Mac (1 MiB of UTF-8 is at most this many characters). */
  streamChars: 1_048_576,
  /** Formatted output above this is saved in the VM and the tool returns its path. */
  inlineChars: 32_000,
} as const;

/** Closed outcomes. An approval timeout is never reported as a denial; a
 * command that could not start is failed, never completed. */
export const LOCAL_COMMAND_OUTCOMES = ["completed", "failed", "denied", "approval_timed_out", "command_timed_out", "mac_not_connected", "no_target", "disabled", "cancelled", "interrupted"] as const;
export type LocalCommandOutcome = typeof LOCAL_COMMAND_OUTCOMES[number];
/** Why a failed command could not start, carried in `error`: exactly one of
 * these, and kept in an erased receipt (wire v1.2). */
export const LOCAL_COMMAND_FAILURE_REASONS = ["cwd_not_found", "spawn_failed"] as const;

const text = (max: number) => z.string().min(1).max(max).refine(value => !value.includes("\u0000") && value.trim().length > 0);
export const LocalCommandInputSchema = z.object({
  command: text(LOCAL_COMMAND_LIMITS.commandChars),
  cwd: text(LOCAL_COMMAND_LIMITS.cwdChars).optional(),
  description: text(LOCAL_COMMAND_LIMITS.textChars).optional(),
  reason: text(LOCAL_COMMAND_LIMITS.textChars).optional(),
  timeoutMs: z.number().int().min(1).max(LOCAL_COMMAND_LIMITS.extendedTimeoutMs).optional(),
  extendedTimeoutReason: text(LOCAL_COMMAND_LIMITS.textChars).optional(),
  /** Another connected Mac of the same person, by its name. */
  mac: text(LOCAL_COMMAND_LIMITS.macChars).optional(),
}).strict().refine(value => value.timeoutMs === undefined || value.timeoutMs <= LOCAL_COMMAND_LIMITS.timeoutMs || value.extendedTimeoutReason !== undefined,
  { message: "A timeout above 120 s needs extendedTimeoutReason.", path: ["extendedTimeoutReason"] });
export type LocalCommandInput = z.infer<typeof LocalCommandInputSchema>;

const bytes = (value: string) => new TextEncoder().encode(value).length;
const stream = z.string().max(LOCAL_COMMAND_LIMITS.streamChars).refine(value => bytes(value) <= LOCAL_COMMAND_LIMITS.streamChars, "Stream exceeds 1 MiB");
const MAC_OUTCOMES = ["completed", "failed", "denied", "approval_timed_out", "command_timed_out", "cancelled", "interrupted"] as const;
const resultFields = {
  code: z.number().int().nullable().optional(),
  stdout: stream.optional(),
  stderr: stream.optional(),
  /** The directory the command ran in, as resolved on the Mac. */
  cwd: z.string().max(LOCAL_COMMAND_LIMITS.cwdChars).optional(),
  timedOut: z.boolean().optional(),
  denied: z.boolean().optional(),
  stdoutTruncated: z.boolean().optional(),
  stderrTruncated: z.boolean().optional(),
  error: z.string().max(LOCAL_COMMAND_LIMITS.textChars).optional(),
};
const failedRule = (value: { outcome: string; error?: string; code?: number | null }) =>
  value.outcome !== "failed" || ((LOCAL_COMMAND_FAILURE_REASONS as readonly string[]).includes(value.error ?? "") && value.code === undefined);
const failedMessage = { message: "A failed command carries a closed reason and no code.", path: ["error"] };

export const LocalCommandResultSchema = z.object({
  outcome: z.enum(LOCAL_COMMAND_OUTCOMES),
  ...resultFields,
  /** The Mac's name, for the transcript. */
  mac: z.string().max(LOCAL_COMMAND_LIMITS.macChars).optional(),
  /** Recovery hint: the latest sender's eligible Macs, by name only. */
  connectedMacs: z.array(z.object({ name: z.string().min(1).max(LOCAL_COMMAND_LIMITS.macChars), isDefault: z.boolean() }).strict()).max(20).optional(),
}).strict().refine(failedRule, failedMessage)
  .refine(value => value.connectedMacs === undefined || value.outcome === "no_target" || value.outcome === "mac_not_connected",
    { message: "connectedMacs belongs to no_target and mac_not_connected only.", path: ["connectedMacs"] });
export type LocalCommandResult = z.infer<typeof LocalCommandResultSchema>;

/** What a Mac reports for its own run: no Mac name, no hints, only its outcomes. */
export const LocalCommandMacResultSchema = z.object({ outcome: z.enum(MAC_OUTCOMES), ...resultFields }).strict().refine(failedRule, failedMessage);
export type LocalCommandMacResult = z.infer<typeof LocalCommandMacResultSchema>;

// Order 2 wire v1.1: control plane routes for the worker (W) and the device (D + H).
const uuid = z.string().uuid();
const iso = z.string().datetime();
const id = z.string().min(1).max(256).refine(value => !/[\u0000-\u001f]/.test(value));
const deviceName = z.string().min(1).max(LOCAL_COMMAND_LIMITS.macChars).refine(value => value.trim() === value && value.length > 0 && !/[\u0000-\u001f\u007f]/.test(value));
const capabilities = z.tuple([z.literal(LOCAL_COMMANDS_FEATURE)]);

export const LocalCommandReceiptSchema = z.object({
  requestId: uuid, state: z.enum(["pending", "claimed", "terminal"]), approvalDeadline: iso, runDeadline: iso.nullable(),
  mac: z.string().max(LOCAL_COMMAND_LIMITS.macChars).nullable(), result: LocalCommandResultSchema.nullable(), outputAvailable: z.boolean(),
}).strict();
export type LocalCommandReceipt = z.infer<typeof LocalCommandReceiptSchema>;
export const LocalCommandWorkerCreateSchema = z.object({ requestId: uuid, chatId: id, executionId: id, input: LocalCommandInputSchema }).strict();
export const LocalCommandRetireSenderSchema = z.object({ chatId: id, executionId: id }).strict();

export const LocalCommandPresenceSchema = z.object({ presenceRequired: z.boolean(), reachableUntil: iso.nullable() }).strict();
export type LocalCommandPresence = z.infer<typeof LocalCommandPresenceSchema>;
export const LocalCommandDeviceSchema = z.object({ deviceId: uuid, registrationId: uuid, instanceId: uuid, name: deviceName, capabilities }).strict();
export type LocalCommandDevice = z.infer<typeof LocalCommandDeviceSchema>;
export const LocalCommandRegistrationRequestSchema = z.object({ requestId: uuid, name: deviceName, capabilities }).strict();
export const LocalCommandRegistrationReplySchema = z.object({ device: LocalCommandDeviceSchema, presence: LocalCommandPresenceSchema, heartbeatIntervalMs: z.literal(25_000) }).strict();
export const LocalCommandMacSchema = z.object({ deviceId: uuid, name: deviceName, connected: z.boolean(), active: z.boolean(), reachable: z.boolean(), expiresAt: iso.nullable() }).strict();
export type LocalCommandMac = z.infer<typeof LocalCommandMacSchema>;
export const LocalCommandMacsReplySchema = z.object({ macs: z.array(LocalCommandMacSchema).max(20) }).strict();
export const LocalCommandConnectReplySchema = z.object({ mac: LocalCommandMacSchema, presence: LocalCommandPresenceSchema }).strict();
export const LocalCommandDisconnectReplySchema = z.object({ mac: LocalCommandMacSchema }).strict();

const workspaceLabel = z.object({ id: uuid, name: z.string().max(120), title: z.string().max(120).nullable() }).strict();
const chatLabel = z.object({ id, title: z.string().max(4096) }).strict();
export const LocalCommandPendingNoticeSchema = z.object({
  requestId: uuid, state: z.enum(["pending", "claimed"]), workspace: workspaceLabel, chat: chatLabel, input: LocalCommandInputSchema,
  mac: deviceName, defaultMac: deviceName.nullable(), isDefaultTarget: z.boolean(), createdAt: iso, approvalDeadline: iso, runDeadline: iso.nullable(),
}).strict();
export type LocalCommandPendingNotice = z.infer<typeof LocalCommandPendingNoticeSchema>;
export const LocalCommandTerminalNoticeSchema = z.object({ requestId: uuid, state: z.literal("terminal"), outcome: z.enum(LOCAL_COMMAND_OUTCOMES) }).strict();
/** Notices never carry a result or output. */
export const LocalCommandNoticeSchema = z.union([LocalCommandPendingNoticeSchema, LocalCommandTerminalNoticeSchema]);
export type LocalCommandNotice = z.infer<typeof LocalCommandNoticeSchema>;
export const LocalCommandClaimSchema = z.object({ decision: z.enum(["approve", "deny"]) }).strict();
export const LocalCommandResultBodySchema = z.object({ result: LocalCommandMacResultSchema }).strict();
export const LocalCommandResultReplySchema = z.object({ outcome: z.enum(LOCAL_COMMAND_OUTCOMES) }).strict();

/** Account-level device channel events, by exact SSE event name. */
export const LocalCommandEventSchemas = {
  ready: z.object({ deviceId: uuid, registrationId: uuid, instanceId: uuid, presence: LocalCommandPresenceSchema, heartbeatIntervalMs: z.literal(25_000) }).strict(),
  presence: LocalCommandPresenceSchema,
  request: LocalCommandNoticeSchema,
  heartbeat: z.object({ at: iso, presence: LocalCommandPresenceSchema }).strict(),
  revoked: z.object({ code: z.enum(["session_revoked", "device_registration_changed"]) }).strict(),
  /** notify-user-v1 (batch B1) shares the account-level device channel. */
  notify: NotifyUserEventSchema,
} as const;

export const LocalCommandOrganizationSettingSchema = z.object({ localCommandsEnabled: z.boolean() }).strict();

/** Device headers (H) on every device route except registration, and on a desktop prompt send. */
export const LOCAL_COMMAND_DEVICE_HEADERS = { deviceId: "X-Zeros-Device-Id", registrationId: "X-Zeros-Device-Registration", instanceId: "X-Zeros-Device-Instance" } as const;
