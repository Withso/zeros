import { describe, expect, it } from "vitest";
import { LOCAL_COMMAND_OUTCOMES, LocalCommandInputSchema, LocalCommandResultSchema, LOCAL_COMMAND_LIMITS } from "../local-commands";
import { CloudV2ControlFrameSchema } from "../cloud-v2-relay";

describe("RunLocalCommand input", () => {
  it("defaults nothing itself and bounds the timeout: 120 s plainly, up to 30 min only with a reason", () => {
    expect(LocalCommandInputSchema.parse({ command: "ls -la" })).toEqual({ command: "ls -la" });
    expect(LocalCommandInputSchema.safeParse({ command: "make", timeoutMs: 120_000 }).success).toBe(true);
    expect(LocalCommandInputSchema.safeParse({ command: "make", timeoutMs: 120_001 }).success).toBe(false);
    expect(LocalCommandInputSchema.safeParse({ command: "make", timeoutMs: 1_800_000, extendedTimeoutReason: "Full iOS build" }).success).toBe(true);
    expect(LocalCommandInputSchema.safeParse({ command: "make", timeoutMs: 1_800_000, extendedTimeoutReason: "   " }).success).toBe(false);
    expect(LocalCommandInputSchema.safeParse({ command: "make", timeoutMs: 1_800_001, extendedTimeoutReason: "x" }).success).toBe(false);
    for (const bad of [{ command: "" }, { command: "   " }, { command: "x".repeat(LOCAL_COMMAND_LIMITS.commandChars + 1) }, { command: "ls", timeoutMs: 0 },
      { command: "ls", timeoutMs: 1.5 }, { command: "ls", cwd: "" }, { command: "ls", mac: "" }, { command: "ls", extra: 1 }, { command: "a\u0000b" }])
      expect(LocalCommandInputSchema.safeParse(bad).success, JSON.stringify(bad).slice(0, 60)).toBe(false);
    expect(LocalCommandInputSchema.safeParse({ command: "ls", cwd: "~/src", description: "List", reason: "Check files", mac: "Alex's MacBook Pro" }).success).toBe(true);
  });
});

describe("RunLocalCommand result", () => {
  it("names one closed outcome and keeps each stream within its cap", () => {
    expect(LOCAL_COMMAND_OUTCOMES).toEqual(["completed", "failed", "denied", "approval_timed_out", "command_timed_out", "mac_not_connected", "no_target", "disabled", "cancelled", "interrupted"]);
    // A command that could not start is failed, with a closed reason; never completed.
    expect(LocalCommandResultSchema.safeParse({ outcome: "failed", error: "cwd_not_found", cwd: "/Users/alex/nope" }).success).toBe(true);
    expect(LocalCommandResultSchema.safeParse({ outcome: "failed", error: "spawn_failed" }).success).toBe(true);
    for (const error of [undefined, "something else"]) expect(LocalCommandResultSchema.safeParse({ outcome: "failed", ...(error ? { error } : {}) }).success).toBe(false);
    expect(LocalCommandResultSchema.parse({ outcome: "completed", code: 0, stdout: "ok\n", stderr: "", cwd: "/Users/alex", mac: "Alex's Mac" })).toMatchObject({ outcome: "completed" });
    expect(LocalCommandResultSchema.parse({ outcome: "approval_timed_out" })).toEqual({ outcome: "approval_timed_out" });
    expect(LocalCommandResultSchema.safeParse({ outcome: "command_timed_out", timedOut: true, stdoutTruncated: true, stdout: "x".repeat(LOCAL_COMMAND_LIMITS.streamChars) }).success).toBe(true);
    for (const bad of [{ outcome: "maybe" }, { outcome: "completed", stdout: "x".repeat(LOCAL_COMMAND_LIMITS.streamChars + 1) }, { outcome: "completed", code: 1.5 }, { outcome: "completed", extra: 1 }])
      expect(LocalCommandResultSchema.safeParse(bad).success).toBe(false);
  });
});

describe("local commands configuration (provisional until the control-plane shapes are fixed)", () => {
  const config = { t: "config", loginRevision: "0", agents: {}, workspace: {
    id: "7f1f6c1e-3b0a-4f7e-9d43-8a0b2b9c6d11", organizationId: "7f1f6c1e-3b0a-4f7e-9d43-8a0b2b9c6d11", checkoutPath: "/home/user/o/r", repository: "o/r", branch: "b", baseBranch: "main" } };
  it("keeps the flag optional and exact, so an older control plane's configuration still parses", () => {
    expect(CloudV2ControlFrameSchema.safeParse(config).success).toBe(true);
    expect(CloudV2ControlFrameSchema.safeParse({ ...config, localCommands: 1 }).success).toBe(true);
    for (const localCommands of [0, 2, true, "1"]) expect(CloudV2ControlFrameSchema.safeParse({ ...config, localCommands }).success).toBe(false);
    const current = CloudV2ControlFrameSchema.options.find(option => option.shape.t.value === "config") as Extract<(typeof CloudV2ControlFrameSchema.options)[number], { shape: { localCommands: unknown } }>;
    const previous = current.omit({ localCommands: true }).strict();
    expect(previous.safeParse({ ...config, localCommands: 1 }).success).toBe(false);
  });
});

import {
  LocalCommandReceiptSchema, LocalCommandNoticeSchema, LocalCommandMacResultSchema, LocalCommandDeviceSchema, LocalCommandPresenceSchema,
  LocalCommandMacSchema, LocalCommandRegistrationRequestSchema, LocalCommandRegistrationReplySchema, LocalCommandEventSchemas,
  LocalCommandWorkerCreateSchema, LocalCommandClaimSchema, LocalCommandOrganizationSettingSchema,
} from "../local-commands";

const uuid = "7f1f6c1e-3b0a-4f7e-9d43-8a0b2b9c6d11", other = "8f1f6c1e-3b0a-4f7e-9d43-8a0b2b9c6d12";
const iso = "2026-11-10T12:00:00.000Z";
const presence = { presenceRequired: true, reachableUntil: iso };
const pending = { requestId: uuid, state: "pending", workspace: { id: uuid, name: "w-7", title: "Fix login" }, chat: { id: "chat-1", title: "Simulator" },
  input: { command: "ls" }, mac: "Alex's Mac", defaultMac: "Alex's Mac", isDefaultTarget: true, createdAt: iso, approvalDeadline: iso, runDeadline: null };

describe("order 2 wire v1.1 shapes", () => {
  it("bounds streams in characters and UTF-8 bytes, and carries connectedMacs only with no_target and mac_not_connected", () => {
    const wide = "é".repeat(600_000);
    expect(LocalCommandResultSchema.safeParse({ outcome: "completed", code: 0, stdout: wide }).success).toBe(false);
    expect(LocalCommandResultSchema.safeParse({ outcome: "no_target", connectedMacs: [{ name: "Studio", isDefault: false }] }).success).toBe(true);
    expect(LocalCommandResultSchema.safeParse({ outcome: "mac_not_connected", connectedMacs: [] }).success).toBe(true);
    expect(LocalCommandResultSchema.safeParse({ outcome: "completed", connectedMacs: [] }).success).toBe(false);
    expect(LocalCommandResultSchema.safeParse({ outcome: "no_target", connectedMacs: Array.from({ length: 21 }, (_, i) => ({ name: `m${i}`, isDefault: false })) }).success).toBe(false);
    expect(LocalCommandResultSchema.safeParse({ outcome: "failed", error: "cwd_not_found", code: 1 }).success).toBe(false);
  });

  it("accepts from the Mac only its own outcomes, without mac or connectedMacs", () => {
    for (const outcome of ["completed", "failed", "denied", "approval_timed_out", "command_timed_out", "cancelled", "interrupted"])
      expect(LocalCommandMacResultSchema.safeParse({ outcome, ...(outcome === "failed" ? { error: "spawn_failed" } : {}) }).success, outcome).toBe(true);
    for (const outcome of ["mac_not_connected", "no_target", "disabled"]) expect(LocalCommandMacResultSchema.safeParse({ outcome }).success, outcome).toBe(false);
    expect(LocalCommandMacResultSchema.safeParse({ outcome: "completed", mac: "Studio" }).success).toBe(false);
  });

  it("parses receipts, devices, presence, Macs and registration strictly", () => {
    expect(LocalCommandReceiptSchema.parse({ requestId: uuid, state: "terminal", approvalDeadline: iso, runDeadline: null, mac: "Studio",
      result: { outcome: "denied", denied: true }, outputAvailable: false }).state).toBe("terminal");
    // v1.2: an erased receipt keeps outcome, mac and, for failed, the closed reason; nothing else is needed.
    expect(LocalCommandReceiptSchema.parse({ requestId: uuid, state: "terminal", approvalDeadline: iso, runDeadline: iso, mac: "Studio",
      result: { outcome: "failed", error: "spawn_failed", mac: "Studio" }, outputAvailable: false }).result).toEqual({ outcome: "failed", error: "spawn_failed", mac: "Studio" });
    expect(LocalCommandReceiptSchema.safeParse({ requestId: uuid, state: "terminal", approvalDeadline: iso, runDeadline: iso, mac: "Studio",
      result: { outcome: "failed", mac: "Studio" }, outputAvailable: false }).success).toBe(false);
    expect(LocalCommandReceiptSchema.safeParse({ requestId: uuid, state: "pending", approvalDeadline: iso, runDeadline: null, mac: null, result: null, outputAvailable: false, extra: 1 }).success).toBe(false);
    expect(LocalCommandDeviceSchema.safeParse({ deviceId: uuid, registrationId: other, instanceId: uuid, name: "Studio", capabilities: ["local-commands-v1"] }).success).toBe(true);
    expect(LocalCommandDeviceSchema.safeParse({ deviceId: uuid, registrationId: other, instanceId: uuid, name: "Studio", capabilities: [] }).success).toBe(false);
    expect(LocalCommandPresenceSchema.safeParse({ presenceRequired: false, reachableUntil: null }).success).toBe(true);
    expect(LocalCommandMacSchema.safeParse({ deviceId: uuid, name: "Studio", connected: true, active: false, reachable: true, expiresAt: iso }).success).toBe(true);
    expect(LocalCommandRegistrationRequestSchema.safeParse({ requestId: uuid, name: "Studio", capabilities: ["local-commands-v1"] }).success).toBe(true);
    for (const name of ["", " ", "x".repeat(129), "bad\u0007name", "del\u007f"])
      expect(LocalCommandRegistrationRequestSchema.safeParse({ requestId: uuid, name, capabilities: ["local-commands-v1"] }).success, JSON.stringify(name)).toBe(false);
    expect(LocalCommandRegistrationReplySchema.safeParse({ device: { deviceId: uuid, registrationId: other, instanceId: uuid, name: "Studio", capabilities: ["local-commands-v1"] },
      presence, heartbeatIntervalMs: 25000 }).success).toBe(true);
  });

  it("separates pending and terminal notices, and never lets a notice carry output", () => {
    expect(LocalCommandNoticeSchema.parse(pending).state).toBe("pending");
    expect(LocalCommandNoticeSchema.parse({ requestId: uuid, state: "terminal", outcome: "cancelled" })).toEqual({ requestId: uuid, state: "terminal", outcome: "cancelled" });
    expect(LocalCommandNoticeSchema.safeParse({ requestId: uuid, state: "terminal", outcome: "completed", result: { outcome: "completed" } }).success).toBe(false);
    expect(LocalCommandNoticeSchema.safeParse({ ...pending, stdout: "x" }).success).toBe(false);
    expect(LocalCommandNoticeSchema.safeParse({ ...pending, workspace: { ...pending.workspace, name: "x".repeat(121) } }).success).toBe(false);
  });

  it("names the SSE events exactly and bounds worker, claim and setting bodies", () => {
    expect(Object.keys(LocalCommandEventSchemas).sort()).toEqual(["heartbeat", "notify", "presence", "ready", "request", "revoked"]);
    expect(LocalCommandEventSchemas.ready.safeParse({ deviceId: uuid, registrationId: other, instanceId: uuid, presence, heartbeatIntervalMs: 25000 }).success).toBe(true);
    expect(LocalCommandEventSchemas.revoked.safeParse({ code: "session_revoked" }).success).toBe(true);
    expect(LocalCommandEventSchemas.revoked.safeParse({ code: "other" }).success).toBe(false);
    expect(LocalCommandEventSchemas.heartbeat.safeParse({ at: iso, presence }).success).toBe(true);
    expect(LocalCommandWorkerCreateSchema.safeParse({ requestId: uuid, chatId: "chat", executionId: "exec", input: { command: "ls" } }).success).toBe(true);
    expect(LocalCommandWorkerCreateSchema.safeParse({ requestId: uuid, chatId: "chat\u0001", executionId: "exec", input: { command: "ls" } }).success).toBe(false);
    expect(LocalCommandClaimSchema.safeParse({ decision: "approve" }).success).toBe(true);
    expect(LocalCommandClaimSchema.safeParse({ decision: "always" }).success).toBe(false);
    expect(LocalCommandOrganizationSettingSchema.parse({ localCommandsEnabled: false })).toEqual({ localCommandsEnabled: false });
  });
});
