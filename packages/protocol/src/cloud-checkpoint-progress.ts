import { z } from "zod";

/** Optional diagnostics, separate from the strict heartbeat wire. A completed
 * stage is not a checkpoint, seal, lease renewal or authority proof.
 * Mirrored in apps/control-plane/src/cloud-workspaces/checkpoint-progress-contract.ts. */
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
