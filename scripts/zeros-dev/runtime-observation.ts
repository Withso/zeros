import { z } from "zod";

// Public evidence is deliberately smaller than the underlying error types.
// Never copy a provider body, WebSocket reason/message, URL or arbitrary code.
export const RuntimeObservationSchema = z.object({
  phase: z.enum(["workspace_read", "identity", "admission", "handshake", "workspace_list"]),
  class: z.enum(["admission_refused", "admission_unavailable", "connect_refused", "handshake_rejected",
    "authority_rejected", "request_timeout", "relay_unavailable", "bad_response", "identity_changed", "workspace_not_running", "unknown"]),
  status: z.number().int().min(100).max(599).optional(),
}).strict();
export type RuntimeObservation = z.infer<typeof RuntimeObservationSchema>;
