import { z } from "zod";

export const browserSubscriptionProviderSchema = z.enum([
  "claude",
  "codex",
  "cursor",
]);
export type BrowserSubscriptionProvider = z.infer<
  typeof browserSubscriptionProviderSchema
>;

const attemptIdSchema = z.string().uuid();
export const subscriptionAccountSchema = z
  .object({
    id: z.string().uuid(),
    deviceAccount: z.boolean().optional(),
    state: z.enum(["connected", "disconnected", "expired"]),
    email: z.string().max(320).optional(),
    plan: z.string().max(100).optional(),
    organization: z.string().max(320).optional(),
    expiresAtMs: z.number().finite().positive().optional(),
  })
  .strict();
export type SavedSubscriptionAccount = z.infer<
  typeof subscriptionAccountSchema
>;

/** Native read-only usage request. Identity is checked against the currently
 * selected native account before and after the provider answers. */
export const providerUsageRequestSchema = z
  .object({
    provider: browserSubscriptionProviderSchema,
    action: z.literal("usage"),
    method: z.enum(["account", "cli"]),
    accountId: z.string().uuid().optional(),
    identity: z.string().max(2048).optional(),
  })
  .strict();
export type ProviderUsageRequest = z.infer<typeof providerUsageRequestSchema>;
export const providerUsageSnapshotSchema = z
  .object({
    provider: browserSubscriptionProviderSchema,
    method: z.enum(["account", "cli"]),
    accountId: z.string().uuid().optional(),
    identity: z.string().max(2048).optional(),
    plan: z.string().max(100).optional(),
    organization: z.string().max(320).optional(),
    windows: z
      .array(
        z
          .object({
            id: z.enum(["five-hour", "weekly", "cursor", "third-party"]),
            usedPercent: z.number().finite().min(0).max(100),
            resetsAt: z.number().finite().positive().optional(),
          })
          .strict(),
      )
      .max(4),
    fetchedAt: z.number().finite().nonnegative(),
  })
  .strict();
export type ProviderUsageSnapshot = z.infer<typeof providerUsageSnapshotSchema>;

/** Matches the existing durable usage key; absent identity cannot own CLI data. */
export function providerUsageIdentity(account: {
  email?: string;
  organization?: string;
}): string | undefined {
  return account.email
    ? JSON.stringify([account.email, account.organization ?? null])
    : undefined;
}
/** Local native auth only: no renderer-supplied executable, URL, environment,
 * workspace path, or provider credential crosses this command boundary. */
export const providerSubscriptionActionSchema = z.discriminatedUnion("action", [
  providerUsageRequestSchema,
  z
    .object({
      provider: browserSubscriptionProviderSchema,
      action: z.enum(["status", "connect"]),
    })
    .strict(),
  z
    .object({
      provider: browserSubscriptionProviderSchema,
      action: z.literal("cancel"),
      attemptId: attemptIdSchema,
    })
    .strict(),
  z
    .object({
      provider: z.literal("claude"),
      action: z.literal("submit-code"),
      attemptId: attemptIdSchema,
      code: z
        .string()
        .trim()
        .min(1)
        .max(4096)
        .regex(/^[A-Za-z0-9_\-.#]+$/),
    })
    .strict(),
  z
    .object({
      provider: browserSubscriptionProviderSchema,
      action: z.enum(["select-account", "remove-account"]),
      accountId: z.string().uuid(),
    })
    .strict(),
  z
    .object({
      provider: browserSubscriptionProviderSchema,
      action: z.literal("select-method"),
      method: z.enum(["account", "cli", "apiKey"]),
    })
    .strict(),
]);
export type ProviderSubscriptionAction = z.infer<
  typeof providerSubscriptionActionSchema
>;
export const providerSubscriptionStatusSchema = z
  .object({
    provider: browserSubscriptionProviderSchema,
    state: z.enum(["connected", "disconnected", "expired", "connecting"]),
    revision: z.number().int().nonnegative(),
    attemptId: attemptIdSchema.optional(),
    canSubmitCode: z.boolean().optional(),
    email: z.string().max(320).optional(),
    plan: z.string().max(100).optional(),
    organization: z.string().max(320).optional(),
    expiresAtMs: z.number().finite().positive().optional(),
    error: z.string().max(500).optional(),
    accounts: z.array(subscriptionAccountSchema).max(20).optional(),
    activeAccountId: z.string().uuid().optional(),
    method: z.enum(["account", "cli", "apiKey"]).optional(),
  })
  .strict();
export type ProviderSubscriptionStatus = z.infer<
  typeof providerSubscriptionStatusSchema
>;

/** Cloud browser ceremonies expose metadata and a short-lived public device
 * code only. Provider tokens and native cache files stay in Electron main. */
export const cloudProviderAuthActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("connect"), attemptId: attemptIdSchema,
    organizationId: z.string().uuid(), provider: z.enum(["codex", "cursor"]), displayName: z.string().trim().min(1).max(80) }).strict(),
  z.object({ action: z.enum(["status", "cancel"]), attemptId: attemptIdSchema }).strict(),
]);
export type CloudProviderAuthAction = z.infer<typeof cloudProviderAuthActionSchema>;
export const cloudProviderCredentialMetadataSchema = z.object({
  id: z.string().uuid(), kind: z.string().max(64), displayName: z.string().max(80), revision: z.number().int().positive(), revoked: z.boolean(),
  connectionMethod: z.enum(["api", "account"]).optional(),
});
export const cloudProviderAuthStatusSchema = z.object({
  attemptId: attemptIdSchema, organizationId: z.string().uuid(), provider: z.enum(["codex", "cursor"]),
  state: z.enum(["connecting", "connected", "failed", "canceled"]),
  deviceCode: z.object({ verificationUrl: z.literal("https://auth.openai.com/codex/device"), userCode: z.string().regex(/^[A-Z0-9-]{4,32}$/) }).strict().optional(),
  credential: cloudProviderCredentialMetadataSchema.optional(),
  error: z.string().max(256).optional(),
}).strict();
export type CloudProviderAuthStatus = z.infer<typeof cloudProviderAuthStatusSchema>;

export const cursorSubscriptionActionSchema = z
  .object({
    action: z.enum(["status", "connect", "cancel", "disconnect"]),
  })
  .strict();
export interface CursorSubscriptionStatus {
  state: "connected" | "disconnected" | "expired" | "connecting";
  email?: string;
  expiresAtMs?: number;
}

/** Private host→engine message only. Never a renderer/relay message. */
const credentialSchema = z.object({
  apiKey: z.string().min(1).max(32_768),
  expiresAtMs: z.number().finite().positive().optional(),
  email: z.string().max(320).optional(),
});
export const providerCredentialsSchema = z
  .object({
    claude: credentialSchema.nullable(),
    codex: credentialSchema.nullable(),
    cursor: credentialSchema.nullable(),
    cursorSubscription: credentialSchema.nullable(),
    // Main-selected profiles only; never accepted from renderer spawn options.
    accountProfiles: z
      .object({
        claude: z
          .object({
            id: z.string().uuid(),
            configDir: z.string().min(1).max(4096).optional(),
            state: z.enum(["connected", "disconnected", "expired"]),
          })
          .nullable(),
        codex: z
          .object({
            id: z.string().uuid(),
            configDir: z.string().min(1).max(4096).optional(),
            state: z.enum(["connected", "disconnected", "expired"]),
          })
          .nullable(),
        cursor: z
          .object({
            id: z.string().uuid(),
            state: z.enum(["connected", "disconnected", "expired"]),
          })
          .nullable(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type ProviderCredentials = z.infer<typeof providerCredentialsSchema>;
