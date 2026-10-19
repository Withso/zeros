import { z } from "zod";
import { executeBoatPinnedSsh, type BoatPinnedSshOptions } from "./boat-pinned-ssh.js";
import { runtimeUpdateCommand, runtimeUpdateSource } from "./runtime-update-runner.js";
import { RuntimeRollbackInputSchema, RuntimeRollbackOfferSchema, RuntimeRollbackScopeSchema,
  type RuntimeRollbackInput, type RuntimeRollbackOffer } from "./runtime-rollback-contract.js";

const envelope = { schema: z.literal("zeros.runtime-rollback-cache/v1"), fence: z.string().uuid(), scope: RuntimeRollbackScopeSchema };
const Frame = z.object({ ...envelope, phase: z.enum(["retain", "retire_authorized", "evict_authorized"]),
  offer: RuntimeRollbackOfferSchema.optional() }).strict();
const Result = z.object({ ...envelope, outcome: z.enum(["evicted", "unchanged"]), retentionId: z.string().uuid().optional() }).strict();
export type RuntimeRollbackResult = z.infer<typeof Result>;
export type RuntimeRollbackHandlers = {
  retain(offer: RuntimeRollbackOffer): Promise<string | null>;
  authorize(phase: "retire_authorized" | "evict_authorized"): Promise<boolean>;
};
function valid(value: unknown): asserts value { if (!value) throw new Error("Runtime rollback response is invalid"); }

/** One ordered, bounded exchange. A missing ACK grants no retirement, and no
 * receipt can be emitted before both post-I/O authority checks succeed. */
export function createRuntimeRollbackConversation(raw: RuntimeRollbackInput, handlers: RuntimeRollbackHandlers, now = Date.now) {
  const parsed = RuntimeRollbackInputSchema.safeParse(raw);
  valid(parsed.success);
  const input = parsed.data;
  const fresh = () => valid(Date.parse(input.expiresAt) > now() && Date.parse(input.expiresAt) - now() <= 120_000);
  fresh();
  let state = "offered", processing = false;
  let retentionId: string | null = null, result: RuntimeRollbackResult | null = null;
  const sameScope = (scope: RuntimeRollbackInput["scope"]) =>
    Object.entries(input.scope).every(([key, expected]) => scope[key as keyof typeof scope] === expected);
  return {
    input,
    async onFrame(line: string): Promise<string | undefined> {
      valid(!processing && !result && Buffer.byteLength(line) <= 16 * 1024);
      processing = true;
      try {
        let raw: unknown;
        try { raw = JSON.parse(line); } catch { valid(false); }
        const terminal = Result.safeParse(raw);
        if (terminal.success) {
          const value = terminal.data;
          valid(value.fence === input.fence && sameScope(value.scope));
          valid(value.outcome === "unchanged" ? state === "offered" && !value.retentionId
            : state === "evict_authorized" && value.retentionId === retentionId);
          fresh(); result = value; return;
        }
        const parsed = Frame.safeParse(raw);
        valid(parsed.success);
        const value = parsed.data;
        valid(value.fence === input.fence && sameScope(value.scope));
        fresh();
        let allow = false;
        if (value.phase === "retain") {
          valid(state === "offered" && value.offer && sameScope(value.offer.scope) &&
            value.offer.currentRuntimeId === input.current.runtimeId && value.offer.baseCompatibilityId === input.current.baseCompatibilityId &&
            value.offer.bootId === input.current.bootId);
          // Move out of offered before I/O, including a thrown/lost ACK.
          state = "denied";
          try { retentionId = await handlers.retain(value.offer); } catch { retentionId = null; }
          fresh();
          allow = z.string().uuid().safeParse(retentionId).success;
          if (allow) state = "retained";
        } else {
          valid(!value.offer && (value.phase === "retire_authorized" ? state === "retained" : state === "retire_authorized"));
          state = "denied";
          try { allow = (await handlers.authorize(value.phase)) === true; } catch { allow = false; }
          fresh();
          if (allow) state = value.phase;
        }
        return JSON.stringify({ schema: input.schema, fence: input.fence, scope: input.scope, phase: value.phase, allow,
          ...(allow && value.phase === "retain" ? { retentionId } : {}) }) + "\n";
      } finally { processing = false; }
    },
    result() { valid(result); return result; },
  };
}

export async function runRuntimeRollbackEviction(input: RuntimeRollbackInput, handlers: RuntimeRollbackHandlers,
  options: BoatPinnedSshOptions, signal: AbortSignal): Promise<RuntimeRollbackResult> {
  const dialog = createRuntimeRollbackConversation(input, handlers);
  const timeoutSeconds = Math.max(1, Math.min(120, Math.ceil((Date.parse(input.expiresAt) - Date.now()) / 1000)));
  const result = await executeBoatPinnedSsh({ resourceId: input.scope.providerResourceId, command: runtimeUpdateCommand(),
    stdin: runtimeUpdateSource() + JSON.stringify(dialog.input) + "\n", timeoutSeconds, onFrame: dialog.onFrame,
  }, { ...options, maxOutputBytes: Math.min(options.maxOutputBytes, 64 * 1024) }, signal);
  valid(result.exitCode === 0 && !result.outputTruncated);
  return dialog.result();
}
