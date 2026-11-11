import { z } from "zod";

// This standalone deployment mirrors packages/protocol/src/notify-user.ts;
// the parity test exercises both copies with the same boundary values.
export const NOTIFY_USER_FEATURE = "notify-user-v1";
export const NOTIFY_USER_LIMITS = { titleChars: 80, messageChars: 280, lifetimeMs: 600_000 } as const;
export const NOTIFY_USER_KINDS = ["review", "blocked"] as const;
const id = z.string().min(1).max(256).refine(value => !/[\u0000-\u001f]/.test(value));
const text = (max: number) => z.string().min(1).max(max).refine(value => value.trim().length > 0, "Text is blank");
export const NotifyUserInputSchema = z.object({
  title: text(NOTIFY_USER_LIMITS.titleChars), message: text(NOTIFY_USER_LIMITS.messageChars), kind: z.enum(NOTIFY_USER_KINDS),
}).strict();
export const NotifyUserWorkerRequestSchema = NotifyUserInputSchema.extend({
  notificationId: z.string().uuid(), chatId: id, userMessageId: id, executionId: id, contextId: z.uuid().optional(),
}).strict();
export type NotifyUserWorkerRequest = z.infer<typeof NotifyUserWorkerRequestSchema>;
export const NotifyUserEventSchema = z.object({
  notificationId: z.string().uuid(),
  workspace: z.object({ id: z.string().uuid(), name: z.string().max(120), title: z.string().max(120).nullable() }).strict(),
  chat: z.object({ id, title: z.string().max(4096) }).strict(),
  kind: z.enum(NOTIFY_USER_KINDS), title: text(NOTIFY_USER_LIMITS.titleChars), message: text(NOTIFY_USER_LIMITS.messageChars),
  createdAt: z.string().datetime(),
}).strict();
export type NotifyUserEvent = z.infer<typeof NotifyUserEventSchema>;
