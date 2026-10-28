// Standalone control-plane mirror; parity is tested from packages/protocol.
import { z } from "zod";

export const CloudGithubMethodSchema = z.enum(["github-app", "pat"]);
export const CloudGithubUnavailableReasonSchema = z.enum([
  "connection-required",
  "connection-expired",
  "connection-changed",
  "installation-required",
  "installation-suspended",
  "access-denied",
  "sso-required",
  "source-review-required",
  "rate-limited",
  "unavailable",
]);
export type CloudGithubUnavailableReason = z.infer<
  typeof CloudGithubUnavailableReasonSchema
>;
const generation = z.string().regex(/^[a-f0-9]{64}$/);
const scope = { organizationId: z.string().uuid(), expected: generation };
export const CloudGithubConnectionMutationSchema = z.discriminatedUnion(
  "action",
  [
    z
      .object({
        ...scope,
        action: z.literal("pat"),
        token: z.string().trim().min(1).max(4096),
      })
      .strict(),
    z.object({ ...scope, action: z.literal("oauth") }).strict(),
    z.object({ ...scope, action: z.literal("cancel") }).strict(),
    z
      .object({
        ...scope,
        action: z.literal("select"),
        method: CloudGithubMethodSchema,
      })
      .strict(),
    z
      .object({
        ...scope,
        action: z.literal("disconnect"),
        method: CloudGithubMethodSchema,
      })
      .strict(),
  ],
);
export const CloudGithubConnectionStatusSchema = z.object({
  generation: z.string().regex(/^[a-f0-9]{64}$/),
  selectedMethod: CloudGithubMethodSchema.nullable(),
  methods: z.object({
    "github-app": method(),
    pat: method(),
  }),
  appAvailable: z.boolean(),
  installUrl: z.string().url().nullable(),
});
function method() {
  return z.object({
    configured: z.boolean(),
    login: z.string().max(100).optional(),
    expiresAt: z.number().nullable().optional(),
    health: z.enum([
      "connected",
      "not-connected",
      "expired",
      "invalid",
      "not-installed",
      "sso-required",
      "rate-limited",
      "unavailable",
    ]),
  });
}
export const CloudGithubRepositoryPageSchema = z.object({
  generation: z.string().regex(/^[a-f0-9]{64}$/),
  repositories: z
    .array(
      z.object({
        id: z.string().regex(/^[1-9][0-9]{0,15}$/),
        owner: z.string().min(1).max(100),
        name: z.string().min(1).max(100),
        defaultBranch: z.string().min(1).max(512),
        private: z.boolean(),
        canPush: z.boolean(),
      }),
    )
    .max(100),
  nextPage: z.number().int().min(1).max(100).nullable(),
  complete: z.boolean(),
});
export const CloudGithubOauthStartedSchema = z.object({
  url: z.string().url(),
  generation: z.string().regex(/^[a-f0-9]{64}$/),
});
export type CloudGithubConnectionStatus = z.infer<
  typeof CloudGithubConnectionStatusSchema
>;
export type CloudGithubRepositoryPage = z.infer<
  typeof CloudGithubRepositoryPageSchema
>;
export type CloudGithubMethod = z.infer<typeof CloudGithubMethodSchema>;
