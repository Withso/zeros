import { z } from "zod";

/** A failed validator predicate, never terminal content or provider error text.
 * Absence means legacy/unavailable diagnostics, not successful task coverage.
 * No defaults or transforms: old device-signed receipts keep their bytes. */
export const NativeProofObservationSchema = z.object({ predicate: z.enum([
  "elapsed_window", "pty_create_unavailable", "pty_not_reattached", "pty_cwd", "pty_exit",
  "replay_truncated", "replay_missing", "replay_bytes", "replay_seed", "replay_first_row", "output_limit",
  "row_prefix", "row_json", "row_schema", "row_identity", "row_sequence", "row_count", "first_row",
  "begin_output", "begin_row", "completion_marker", "heartbeat_gap", "task_duration", "output_changed",
  "file_output", "file_marker", "file_json", "file_schema", "program_hash", "output_hash", "file_rows",
]) }).strict();
export type NativeProofObservation = z.infer<typeof NativeProofObservationSchema>;
