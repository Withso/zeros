import { z } from "zod";

/** Batch B1 wire (CONTRACT.md section 11): the NotifyUser tool on
 * `zeros_workspace`, its worker route and the device channel's `notify`. */
export const NOTIFY_USER_FEATURE = "notify-user-v1";
export const NOTIFY_USER_LIMITS = { titleChars: 80, messageChars: 280, lifetimeMs: 600_000 } as const;
export const NOTIFY_USER_KINDS = ["review", "blocked"] as const;
export type NotifyUserKind = (typeof NOTIFY_USER_KINDS)[number];

const id = z.string().min(1).max(256).refine(value => !/[\u0000-\u001f]/.test(value));
const text = (max: number) => z.string().min(1).max(max).refine(value => value.trim().length > 0, "Text is blank");

/** What the agent passes. Once per turn. */
export const NotifyUserInputSchema = z.object({
  title: text(NOTIFY_USER_LIMITS.titleChars),
  message: text(NOTIFY_USER_LIMITS.messageChars),
  kind: z.enum(NOTIFY_USER_KINDS),
}).strict();
export type NotifyUserInput = z.infer<typeof NotifyUserInputSchema>;

/** `POST /v2/cloud/worker/notifications` body, answered 202. The turn is
 * (chatId, userMessageId): a second one for it answers 409 already_notified,
 * too many 429. executionId is the native session id. */
export const NotifyUserWorkerRequestSchema = NotifyUserInputSchema.extend({
  notificationId: z.string().uuid(), chatId: id, userMessageId: id, executionId: id,
  /** Team sharing (activated acting-user-v1 only): the active turn's execution context. */
  contextId: z.string().uuid().optional(),
}).strict();
export type NotifyUserWorkerRequest = z.infer<typeof NotifyUserWorkerRequestSchema>;

/** Device channel event `notify`: to every registered Mac of the chat's latest
 * desktop sender, dropped after 10 minutes, never replayed. */
export const NotifyUserEventSchema = z.object({
  notificationId: z.string().uuid(),
  workspace: z.object({ id: z.string().uuid(), name: z.string().max(120), title: z.string().max(120).nullable() }).strict(),
  chat: z.object({ id, title: z.string().max(4096) }).strict(),
  kind: z.enum(NOTIFY_USER_KINDS),
  title: text(NOTIFY_USER_LIMITS.titleChars),
  message: text(NOTIFY_USER_LIMITS.messageChars),
  createdAt: z.string().datetime(),
}).strict();
export type NotifyUserEvent = z.infer<typeof NotifyUserEventSchema>;
