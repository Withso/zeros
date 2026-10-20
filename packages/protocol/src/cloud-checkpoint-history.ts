import { z } from "zod";
import { CloudAgentBootScopeSchema, CloudActorProvenanceSchema, CloudAgentCredentialRunInfoSchema } from "./cloud-agent-bootstrap";
import { CloudBootCommandEntrySchema } from "./cloud-commands";
import { CloudLocalCommandHistoryHeadSchema, CloudLocalCommandHistorySchema } from "./cloud-local-mirror";

export const CLOUD_CHECKPOINT_HISTORY_MAX_BYTES = 16 * 1024 * 1024;
// A canonical JSON document can double when embedded as a JSON string. Keep
// room for the fixed authorization envelope without widening ordinary boot I/O.
export const CLOUD_CHECKPOINT_HISTORY_ENVELOPE_MAX_BYTES = 2 * CLOUD_CHECKPOINT_HISTORY_MAX_BYTES + 64 * 1024;
const sequence = z.number().int().safe().nonnegative();
const identity = z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);

/** Frozen presentation/audit facts. Prompt payloads and native authority are
 * deliberately absent, including for receipts that were pending at loss. */
export const CloudCheckpointHistorySnapshotSchema = z.object({
  version: z.literal(1), scope: CloudAgentBootScopeSchema,
  origins: z.array(z.object({ scope: CloudAgentBootScopeSchema, recordSequence: sequence, eventSequence: sequence }).strict()).min(1).max(4096),
  controls: z.array(z.object({ conversationId: identity, revision: sequence, paused: z.boolean() }).strict()).max(10_000),
  commands: z.array(z.object({ conversationId: identity, originWriterEpoch: z.string().uuid(),
    entry: CloudBootCommandEntrySchema.omit({ payload: true }),
    intent: z.object({ userMessageId: identity, agentId: z.string().min(1).max(64) }).strict(),
    actor: CloudActorProvenanceSchema.nullable(), credentialRun: CloudAgentCredentialRunInfoSchema.nullable(),
    history: CloudLocalCommandHistorySchema.nullable(),
  }).strict()).max(100_000),
  heads: z.array(z.object({ conversationId: identity, head: CloudLocalCommandHistoryHeadSchema }).strict()).max(10_000),
  documents: z.array(z.object({ sha256: digest, kind: z.enum(["record", "manifest"]),
    document: z.string().min(1).max(4 * 1024 * 1024),
  }).strict()).max(65_536),
}).strict().superRefine((value, context) => {
  const unique = (keys: string[]) => new Set(keys).size === keys.length;
  if (!unique(value.origins.map(item => item.scope.writerEpoch)) || !unique(value.controls.map(item => item.conversationId)) ||
      !unique(value.heads.map(item => item.conversationId)) || !unique(value.documents.map(item => item.sha256)) ||
      !unique(value.commands.map(item => item.entry.commandId)) ||
      !unique(value.commands.map(item => `${item.conversationId}\0${item.intent.userMessageId}`)))
    context.addIssue({ code: "custom", message: "Checkpoint history contains duplicate identities" });
  const origins = new Map(value.origins.map(item => [item.scope.writerEpoch, item.scope]));
  if (!origins.has(value.scope.writerEpoch) || value.origins.some(item =>
    item.scope.organizationId !== value.scope.organizationId || item.scope.workspaceId !== value.scope.workspaceId ||
    item.scope.generation > value.scope.generation || item.scope.fundingOwnerEpoch > value.scope.fundingOwnerEpoch) ||
    value.heads.some(item => !origins.has(item.head.originWriterEpoch)) || value.commands.some(item => {
      const origin = origins.get(item.originWriterEpoch), pending = ["queued", "dispatching"].includes(item.entry.state);
      return !origin || origin.generation !== item.entry.generation || !pending && item.history === null ||
        (pending || item.entry.executionId !== null) && item.actor === null || item.actor !== null &&
        Object.entries(origin).some(([key, field]) => field !== item.actor!.scope[key as keyof typeof origin]);
    })) context.addIssue({ code: "custom", message: "Checkpoint history source is inconsistent" });
});
export type CloudCheckpointHistorySnapshot = z.infer<typeof CloudCheckpointHistorySnapshotSchema>;
