import { z } from "zod";

const commitId = z.string().regex(/^[0-9a-f]{7,64}$/i);
export const turnIdentitySchema = z.object({
  chatId: z.string().min(1).max(4096),
  turnId: z.string().min(1).max(4096),
});
export type TurnIdentity = z.infer<typeof turnIdentitySchema>;

export const turnHistoryCursorSchema = turnIdentitySchema.extend({
  startedAt: z.number().int().safe(),
});
export type TurnHistoryCursor = z.infer<typeof turnHistoryCursorSchema>;

/** Inclusive endpoints. All/last selections intentionally follow live history;
 * explicit ranges retain their identity across workspace switches and reloads. */
export const changesHistorySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("commits") }),
  z.object({
    kind: z.literal("commit-range"),
    from: commitId,
    to: commitId,
  }),
  z.object({ kind: z.literal("turns") }),
  z.object({ kind: z.literal("last-turn") }),
  z.object({
    kind: z.literal("turn-range"),
    from: turnIdentitySchema,
    to: turnIdentitySchema,
  }),
]);
export type ChangesHistory = z.infer<typeof changesHistorySchema>;

export function changesHistoryKey(history: ChangesHistory): string {
  switch (history.kind) {
    case "commit-range":
      return JSON.stringify([history.kind, history.from, history.to]);
    case "turn-range":
      return JSON.stringify([
        history.kind,
        history.from.chatId,
        history.from.turnId,
        history.to.chatId,
        history.to.turnId,
      ]);
    default:
      return history.kind;
  }
}
