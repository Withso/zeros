import { z } from "zod";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { CloudAgentBootScopeSchema } from "./cloud-agent-bootstrap.js";
import { CloudBootCommandMutationSchema } from "./cloud-commands.js";

/** Optional params.acceptedWorkProof on cloudCommands.request, only for an
 * enqueue with connect.runtimeBinding.acceptedWorkVersion === 1. This
 * optional CP-owned field belongs to the exact admitted boot/funding scope;
 * absence disables accepted-work sending. The native broker
 * supplies this field; it never accepts renderer-supplied proof/token bytes.
 * No field means the unchanged legacy lifetime. A supplied invalid proof is
 * refused, never retried as an ordinary command.
 *
 * proof is an ordinary fresh S1 proof, verified/consumed independently by
 * engine and CP. commandSignature is a second Ed25519 signature by the same
 * device over cloudAcceptedWorkProofMessage. It adds immutable command/boot
 * binding without changing the S1 message, leeway or replay rules. */
export const CloudAcceptedWorkClientProofSchema = z.object({
  version: z.literal(1),
  capability: z.string().min(32).max(4096).regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/),
  proof: z.object({ timestampMs: z.number().int().nonnegative().safe(),
    nonce: z.string().regex(/^[A-Za-z0-9_-]{22}$/), signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/) }).strict(),
  commandSignature: z.string().regex(/^[A-Za-z0-9_-]{86}$/),
}).strict();
export type CloudAcceptedWorkClientProof = z.infer<typeof CloudAcceptedWorkClientProofSchema>;

/** Scope/route/capability identity come from the broker's current admitted
 * runtime. Only commandId/conversationId and the parsed payload come from the
 * enqueue. Cwd, native execution identity and runtime pin remain engine-owned. */
export const CloudAcceptedWorkProofBindingSchema = z.object({
  aud: z.literal("zeros:engine"), wsp: z.string().uuid(), jti: z.string().min(16).max(128),
  scope: CloudAgentBootScopeSchema, commandId: z.string().uuid(),
  conversationId: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/), payloadSha256: z.string().regex(/^[a-f0-9]{64}$/),
  timestampMs: z.number().int().nonnegative().safe(), nonce: z.string().regex(/^[A-Za-z0-9_-]{22}$/),
  route: z.enum(["direct", "relay"]),
}).strict().refine(value => value.wsp === value.scope.workspaceId);
export type CloudAcceptedWorkProofBinding = z.infer<typeof CloudAcceptedWorkProofBindingSchema>;

/** Sign these exact UTF-8 bytes. No trailing newline. Scope tuple order is a
 * wire contract, independent of object property ordering. */
export function cloudAcceptedWorkProofMessage(input: CloudAcceptedWorkProofBinding): string {
  const fields = CloudAcceptedWorkProofBindingSchema.parse(input), scope = fields.scope;
  return ["zeros-accepted-work-v1", fields.aud, fields.wsp, fields.jti,
    JSON.stringify([scope.organizationId, scope.workspaceId, scope.generation, scope.engineInstanceId, scope.bootId,
      scope.writerEpoch, scope.fundingOwnerUserId, scope.fundingOwnerEpoch]), fields.commandId, fields.conversationId,
    fields.payloadSha256, String(fields.timestampMs), fields.nonce, fields.route].join("\n");
}

export function cloudAcceptedWorkCommandBinding(raw: unknown): Pick<CloudAcceptedWorkProofBinding, "commandId" | "conversationId" | "payloadSha256"> {
  const mutation = CloudBootCommandMutationSchema.parse(raw), action = mutation.action;
  if (action.kind !== "enqueue" || action.payload.operation) throw new Error("accepted_work_ineligible");
  const bytes = new TextEncoder().encode(canonical(action.payload));
  if (bytes.length > 192 * 1024) throw new Error("accepted_work_limit");
  return { commandId: action.commandId, conversationId: mutation.conversationId, payloadSha256: bytesToHex(sha256(bytes)) };
}

// Matches the durable queue's bounded canonical payload serialization.
function canonical(value: unknown, budget = { nodes: 0 }, depth = 0): string {
  if (++budget.nodes > 20_000 || depth > 24) throw new Error("accepted_work_invalid");
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(item => canonical(item, budget, depth + 1)).join(",")}]`;
  if (!value || typeof value !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error("accepted_work_invalid");
  return `{${Object.keys(value).sort().map(key => {
    if (key.length > 256 || ["__proto__", "prototype", "constructor"].includes(key)) throw new Error("accepted_work_invalid");
    return `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key], budget, depth + 1)}`;
  }).join(",")}}`;
}
