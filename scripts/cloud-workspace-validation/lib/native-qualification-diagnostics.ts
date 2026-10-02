import { createHash } from "node:crypto";
import { z } from "zod";
import type { AgentFailureKind, AgentFailureStage } from "../../../apps/desktop/src/engine/agents/types";

const phaseSchema = z.enum([
  "input", "actor-admission", "native-start", "provider-home-isolation", "native-git-author", "native-mcp",
  "native-mcp-prompt", "native-mcp-tool-evidence", "native-mcp-proof", "native-mcp-reply", "native-mcp-secret-observation",
  "native-turn", "native-tool-evidence", "access-refresh", "native-goal-set", "native-apps", "native-fork", "transcript-fork",
  "native-resume", "native-goal-reload", "native-mcp-rotation", "native-review", "native-multi-agent", "permission-selection",
  "stop", "native-mcp-removal", "native-mcp-owner-handoff", "revocation",
]);
const failureSchema = z.enum(["timeout", "assertion", "runtime"]);
const kindSchema = z.enum([
  "timeout", "auth-required", "verification-required", "cloud-credentials-unavailable", "subprocess-exited", "protocol-error",
  "transport-closed", "lifecycle-superseded", "rate-limited", "design-protection-failed", "session-expired",
] as const satisfies readonly AgentFailureKind[]);
const stageSchema = z.enum([
  "initialize", "newSession", "loadSession", "forkSession", "prompt", "cancel", "stopBackgroundTask", "setMode",
] as const satisfies readonly AgentFailureStage[]);
const nameSchema = z.enum([
  "Error", "TypeError", "RangeError", "SyntaxError", "ReferenceError", "URIError", "AggregateError", "AbortError",
  "AgentFailureError", "AdmissionCancelledError", "JsonRpcRequestError", "QualificationDeadline", "AssertionError",
]);
const codeSchema = z.enum([
  "EACCES", "EPERM", "ENOENT", "EROFS", "ENOSPC", "ESRCH", "EPIPE", "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT",
  "ENOTFOUND", "EAI_AGAIN", "ABORT_ERR", "ERR_ASSERTION", "ERR_STREAM_PREMATURE_CLOSE", "ERR_PROXY_TUNNEL",
]);
const exitSchema = z.number().int().min(-256).max(256);
const digestSchema = z.string().regex(/^[a-f0-9]{16}$/);
const activityBounds = { permissions: 2048, rejectedPermissions: 2048, questions: 2048, messageChunks: 65_536, toolEvents: 2048 };

export type NativeQualificationPhase = z.infer<typeof phaseSchema>;
type NativeQualificationDiagnostics = {
  phase?: NativeQualificationPhase;
  failure?: z.infer<typeof failureSchema>;
  code?: z.infer<typeof codeSchema>;
  name?: z.infer<typeof nameSchema>;
  kind?: z.infer<typeof kindSchema>;
  stage?: z.infer<typeof stageSchema>;
  exitCode?: number;
  messageSha256?: string;
  activity?: Partial<Record<keyof typeof activityBounds, number>>;
};
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
function selected<Value>(schema: z.ZodType<Value>, value: unknown): Value | undefined {
  const result = schema.safeParse(value);
  return result.success ? result.data : undefined;
}

export function nativeQualificationDiagnostics(value: unknown): NativeQualificationDiagnostics | undefined {
  const report = record(value), activity = record(report.activity);
  const counters = Object.fromEntries(Object.entries(activityBounds).flatMap(([key, bound]) => {
    const count = selected(z.number().int().min(0).max(bound), activity[key]);
    return count === undefined ? [] : [[key, count]];
  }));
  const fields = {
    phase: selected(phaseSchema, report.phase), failure: selected(failureSchema, report.failure),
    code: selected(codeSchema, report.failureCode), name: selected(nameSchema, report.failureName),
    kind: selected(kindSchema, report.failureKind), stage: selected(stageSchema, report.failureStage),
    exitCode: selected(exitSchema, report.failureExitCode), messageSha256: selected(digestSchema, report.failureMessageSha256),
    activity: Object.keys(counters).length ? counters : undefined,
  };
  const diagnostics = Object.fromEntries(Object.entries(fields).filter(([, field]) => field !== undefined));
  return Object.keys(diagnostics).length ? diagnostics as NativeQualificationDiagnostics : undefined;
}

export function failureSignature(error: unknown): { code?: string; name?: string; kind?: string; stage?: string; exitCode?: number; messageSha256?: string } {
  const signature: { code?: string; name?: string; kind?: string; stage?: string; exitCode?: number; messageSha256?: string } = {};
  for (let current: unknown = error, depth = 0; current && typeof current === "object" && depth < 4 && !signature.code; depth++) {
    signature.code = selected(codeSchema, record(current).code);
    current = record(current).cause;
  }
  const value = record(error), failure = record(value.failure);
  signature.name = selected(nameSchema, value.name);
  signature.kind = selected(kindSchema, failure.kind) ?? selected(kindSchema, value.kind);
  signature.stage = selected(stageSchema, failure.stage) ?? selected(stageSchema, value.stage);
  signature.exitCode = selected(exitSchema, record(failure.exit).code);
  const message = value.message;
  if (typeof message === "string" && message.length <= 512)
    signature.messageSha256 = createHash("sha256").update(message).digest("hex").slice(0, 16);
  return Object.fromEntries(Object.entries(signature).filter(([, field]) => field !== undefined));
}
