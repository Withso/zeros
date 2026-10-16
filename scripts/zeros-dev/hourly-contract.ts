import { z } from "zod";
import { Gate0Schema } from "./gate0-contract";
import { InfrastructureSchema } from "./infrastructure-contract";

export const HourlySchema = z.object({
  version: z.literal(1), workflowRunId: z.string().regex(/^[1-9][0-9]{0,19}$/),
  attempt: z.number().int().min(1).max(100), sourceSha: z.string().regex(/^[a-f0-9]{40}$/),
  startedAt: z.string().datetime().optional(), complete: z.boolean(),
  // Absent on the original hourly receipts. A manual rehearsal shares exact
  // cleanup ownership but never supplies the hourly merge-gate result.
  rehearsal: Gate0Schema.optional(),
  infrastructure: InfrastructureSchema.optional(),
  credentials: z.array(z.object({
    agent: z.enum(["claude", "codex", "cursor"]), id: z.string().uuid(), operationId: z.string().uuid(),
    kind: z.enum(["claude-api-key", "claude-setup-token", "codex-api-key", "codex-chatgpt", "cursor-api-key"]),
    revision: z.number().int().positive().safe().optional(),
    selectionRevision: z.number().int().nonnegative().safe(),
    // Intents are saved before each write. Unknown writes never count as absent.
    published: z.boolean(), selected: z.boolean(), disconnected: z.boolean(), revoked: z.boolean(),
  }).strict()).max(3),
  histories: z.array(z.object({ agent: z.enum(["claude", "codex", "cursor"]), promptId: z.string().uuid(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict()).max(3),
  activeWindows: z.array(z.object({ readyObservedAt: z.string().datetime(), workCompletedAt: z.string().datetime(),
    durationMs: z.number().nonnegative().finite() }).strict()).max(6),
}).strict().refine(value => value.infrastructure
  ? !value.complete && !value.rehearsal && value.credentials.length === 0 && value.histories.length === 0
  : value.rehearsal ? !value.complete || value.rehearsal.complete : value.activeWindows.length <= 2);
