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
const evidenceCount = z.number().int().min(0).max(2048);
// Rebuild only complete, coherent fixed summaries. Unknown nested fields are
// stripped; absent or malformed summaries remain unobserved, never zero-filled.
const initialMcpToolEvidenceSchema = z.object({
  version: z.literal(1), events: evidenceCount, overflowed: z.boolean(), uniqueRows: evidenceCount,
  matched: z.object({ rows: evidenceCount, completed: evidenceCount, failed: evidenceCount, pending: evidenceCount,
    unknownStatus: evidenceCount, nativeId: evidenceCount, missingNativeId: evidenceCount, successful: evidenceCount }),
}).refine(({ events, overflowed, uniqueRows, matched }) =>
  (!overflowed || events === 2048) && uniqueRows <= events && matched.rows <= uniqueRows &&
  matched.completed + matched.failed + matched.pending + matched.unknownStatus === matched.rows &&
  matched.nativeId + matched.missingNativeId === matched.rows &&
  matched.successful <= Math.min(matched.completed, matched.nativeId) &&
  matched.successful >= matched.completed - matched.missingNativeId);
const questionEvidenceSchema = z.object({
  version: z.literal(1), requests: evidenceCount, overflowed: z.boolean(),
  sources: z.object({ native_dialog: evidenceCount, native_rpc: evidenceCount, inferred_from_text: evidenceCount, unknown: evidenceCount }),
  blocking: z.object({ yes: evidenceCount, no: evidenceCount, unknown: evidenceCount }),
  elicitation: z.object({ mcp: evidenceCount, notIndicated: evidenceCount, unknown: evidenceCount }),
}).refine(({ requests, overflowed, sources, blocking, elicitation }) =>
  (!overflowed || requests === 2048) &&
  sources.native_dialog + sources.native_rpc + sources.inferred_from_text + sources.unknown === requests &&
  blocking.yes + blocking.no + blocking.unknown === requests &&
  elicitation.mcp + elicitation.notIndicated + elicitation.unknown === requests &&
  elicitation.mcp <= Math.min(sources.native_rpc, blocking.yes));

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
  initialMcpToolEvidence?: z.infer<typeof initialMcpToolEvidenceSchema>;
  questionEvidence?: z.infer<typeof questionEvidenceSchema>;
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
    initialMcpToolEvidence: selected(initialMcpToolEvidenceSchema, report.initialMcpToolEvidence),
    questionEvidence: selected(questionEvidenceSchema, report.questionEvidence),
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
