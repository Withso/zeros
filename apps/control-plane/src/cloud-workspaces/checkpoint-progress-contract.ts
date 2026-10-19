import { z } from "zod";

/** Optional diagnostics, separate from the strict heartbeat wire. A completed
 * stage is not a checkpoint, seal, lease renewal or authority proof.
 * Mirrored in packages/protocol/src/cloud-checkpoint-progress.ts. */
export const CLOUD_WORKSPACE_ENGINE_CHECKPOINT_PROGRESS_PATH =
  "/internal/v1/cloud-workspaces/engine/checkpoint-progress";

export const CloudCheckpointProgressSchema = z.object({
  version: z.literal(1),
  organizationId: z.string().uuid(),
  workspaceId: z.string().uuid(),
  generation: z.number().int().positive().safe(),
  engineInstanceId: z.string().uuid(),
  requestId: z.string().uuid(),
  sequence: z.number().int().min(1).max(64),
  stage: z.enum([
    "checkpoint_received", "service_pause", "process_starts", "setup_stop",
    "run_stop", "agent_retirement", "workload_drain", "terminal_drain",
    "record_flush", "boot_quiesce", "native_pump", "command_drain",
    "event_flush", "record_handoff", "mirror_flush", "seal_create",
    "normal_freeze", "seal_ack", "checkpoint_capture", "durability_capture",
    "final_completion",
  ]),
  state: z.enum(["running", "failed", "completed"]),
  reason: z.enum([
    "none", "deadline", "authority_rejected", "native_custody",
    "pending_work", "storage", "mirror", "unknown",
  ]),
  elapsedMs: z.number().int().min(0).max(300_000),
}).strict().refine(value => (value.state === "failed") === (value.reason !== "none"), {
  message: "Only failed checkpoint stages carry a failure reason",
});

export type CloudCheckpointProgress = z.infer<typeof CloudCheckpointProgressSchema>;

/** Additive HTTP metadata, never a field in the strict v1 progress JSON.
 * Older servers ignore it; a new server stores a separate audit receipt so
 * older servers can still read every v1 receipt after a rollback. */
export const CLOUD_CHECKPOINT_SEAL_REFUSAL_HEADER = "x-zeros-checkpoint-seal-refusal";
export const CloudCheckpointSealRefusalSchema = z.object({
  version: z.literal(1),
  site: z.enum(["request", "response", "frozen_head", "ack_persistence"]),
  code: z.enum([
    "command_conflict", "command_context_changed", "engine_authority_rejected", "cloud_actor_authority_rejected",
    "invalid_command", "command_limit", "command_service_unavailable", "command_response_invalid", "command_storage_unavailable", "unknown",
  ]),
  httpClass: z.enum(["none", "2xx", "4xx", "5xx", "other"]),
}).strict();
export type CloudCheckpointSealRefusal = z.infer<typeof CloudCheckpointSealRefusalSchema>;

export function parseCloudCheckpointSealRefusal(header: string | undefined): CloudCheckpointSealRefusal | undefined {
  if (!header || header.length > 512) return;
  try {
    const parsed = CloudCheckpointSealRefusalSchema.safeParse(JSON.parse(header));
    return parsed.success ? parsed.data : undefined;
  } catch { return; }
}

/** Optional capture evidence uses its own header/audit, never the strict v1
 * body or heartbeat. It cannot prove durability or resolve an ambiguous ACK. */
export const CLOUD_CHECKPOINT_CAPTURE_FAILURE_HEADER = "x-zeros-checkpoint-capture-failure";
export const CloudCheckpointCaptureFailureSchema = z.object({
  version: z.literal(1),
  site: z.enum([
    "projection", "file_scan", "file_upload", "content_append", "native_inventory",
    "native_pack", "native_upload", "native_verify", "final_verify", "manifest_upload", "commit", "commit_ack",
  ]),
  reason: z.enum([
    "deadline", "request_timeout", "transport", "authority", "http_refusal", "response_invalid", "integrity",
    "working_tree_changed", "native_changed", "design_changed", "native_invalid", "filesystem", "git_failed",
    "revision_conflict", "idempotency_conflict", "request_not_current", "unknown",
  ]),
  httpClass: z.enum(["none", "2xx", "4xx", "5xx", "other"]),
}).strict();
export type CloudCheckpointCaptureFailure = z.infer<typeof CloudCheckpointCaptureFailureSchema>;

export function parseCloudCheckpointCaptureFailure(header: string | undefined): CloudCheckpointCaptureFailure | undefined {
  if (!header || header.length > 512) return;
  try {
    const parsed = CloudCheckpointCaptureFailureSchema.safeParse(JSON.parse(header));
    return parsed.success ? parsed.data : undefined;
  } catch { return; }
}
