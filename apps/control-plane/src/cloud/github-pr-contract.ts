// Mirror of packages/protocol/src/cloud-github-pr.ts. This application deploys
// independently and does not import the desktop protocol package.
import { z } from "zod";

const sha = z.string().regex(/^[a-f0-9]{40}$/);
const number = z.number().int().positive().max(2_147_483_647);
const branch = z
  .string()
  .min(1)
  .max(255)
  .refine(
    (value) =>
      !/[\0-\x20\x7f~^:?*\[\\]/.test(value) &&
      !value.startsWith("-") &&
      !value.includes(".."),
  );
const body = z
  .string()
  .max(60_000)
  .refine((value) => value.trim().length > 0 && !value.includes("\0"));
const path = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (value) =>
      !/^[\\/]|^[A-Za-z]:|[\0-\x1f\\]/.test(value) &&
      value
        .split("/")
        .every((part) => part !== "" && part !== "." && part !== ".."),
  );
const revision = { headSha: sha, baseSha: sha };

/** Non-secret authority captured by a read. A write cannot silently cross a
 * connection change, repository transfer, or confirmed checkout change. */
export const CloudGithubPrAuthoritySchema = z
  .object({
    connectionGeneration: z.string().min(1).max(128),
    repositoryId: z.string().regex(/^[1-9][0-9]{0,15}$/),
    repository: z
      .string()
      .regex(/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/),
    branch,
    baseBranch: branch,
    contextRevision: z.string().min(1).max(128),
  })
  .strict();
export type CloudGithubPrAuthority = z.infer<
  typeof CloudGithubPrAuthoritySchema
>;
const expected = CloudGithubPrAuthoritySchema.optional();
const read = (
  op:
    | "gh.prGet"
    | "gh.prChecks"
    | "gh.prCommits"
    | "gh.prReviews"
    | "gh.prInlineReview"
    | "gh.prReviewDiff",
) =>
  z
    .object({
      op: z.literal(op),
      params: z.object({ prNumber: number }).strict(),
      expected,
    })
    .strict();
export const CloudGithubPrRequestSchema = z.discriminatedUnion("op", [
  z
    .object({
      op: z.literal("gh.authStatus"),
      params: z.object({}).strict(),
      expected,
    })
    .strict(),
  z
    .object({
      op: z.literal("gh.repoAccess"),
      params: z.object({}).strict(),
      expected,
    })
    .strict(),
  z
    .object({
      op: z.literal("gh.prSync"),
      params: z
        .object({
          url: z
            .string()
            .regex(
              /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/[1-9][0-9]*$/,
            )
            .optional(),
        })
        .strict(),
      expected,
    })
    .strict(),
  z
    .object({
      op: z.literal("gh.prList"),
      params: z
        .object({ state: z.enum(["open", "closed", "all"]).optional() })
        .strict(),
      expected,
    })
    .strict(),
  read("gh.prGet"),
  read("gh.prChecks"),
  read("gh.prCommits"),
  read("gh.prReviews"),
  read("gh.prInlineReview"),
  read("gh.prReviewDiff"),
  z
    .object({
      op: z.literal("gh.prCreate"),
      expected: CloudGithubPrAuthoritySchema,
      params: z
        .object({
          title: z.string().trim().min(1).max(256),
          body: z.string().max(60_000),
          draft: z.boolean().optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      op: z.literal("gh.prUpdate"),
      expected: CloudGithubPrAuthoritySchema,
      params: z
        .object({
          prNumber: number,
          ...revision,
          title: z.string().trim().min(1).max(256).optional(),
          body: z.string().max(60_000).optional(),
          state: z.enum(["open", "closed"]).optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      op: z.literal("gh.prMarkReady"),
      expected: CloudGithubPrAuthoritySchema,
      params: z.object({ prNumber: number, ...revision }).strict(),
    })
    .strict(),
  z
    .object({
      op: z.literal("gh.prMerge"),
      expected: CloudGithubPrAuthoritySchema,
      params: z
        .object({
          prNumber: number,
          ...revision,
          method: z.enum(["squash", "merge", "rebase"]),
          commitTitle: z.string().max(256).optional(),
          commitMessage: z.string().max(60_000).optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      op: z.literal("gh.prComment"),
      expected: CloudGithubPrAuthoritySchema,
      params: z.discriminatedUnion("kind", [
        z
          .object({
            prNumber: number,
            ...revision,
            kind: z.literal("conversation"),
            body,
          })
          .strict(),
        z
          .object({
            prNumber: number,
            ...revision,
            kind: z.literal("line"),
            body,
            path,
            side: z.enum(["LEFT", "RIGHT"]),
            line: number,
            startLine: number.optional(),
          })
          .strict(),
        z
          .object({
            prNumber: number,
            ...revision,
            kind: z.literal("reply"),
            body,
            commentId: z.number().int().positive().safe(),
          })
          .strict(),
        z
          .object({
            prNumber: number,
            ...revision,
            kind: z.literal("resolve"),
            threadId: z
              .string()
              .min(1)
              .max(256)
              .regex(/^[A-Za-z0-9_+/=-]+$/),
            resolved: z.boolean(),
          })
          .strict(),
      ]),
    })
    .strict(),
]);
export type CloudGithubPrRequest = z.infer<typeof CloudGithubPrRequestSchema>;
export const CLOUD_GITHUB_PR_WRITES: ReadonlySet<string> = new Set([
  "gh.prCreate",
  "gh.prUpdate",
  "gh.prMarkReady",
  "gh.prMerge",
  "gh.prComment",
]);
export const CLOUD_GITHUB_PR_OPERATIONS: ReadonlySet<string> = new Set([
  "gh.authStatus",
  "gh.repoAccess",
  "gh.prSync",
  "gh.prList",
  "gh.prGet",
  "gh.prChecks",
  "gh.prCommits",
  "gh.prReviews",
  "gh.prInlineReview",
  "gh.prReviewDiff",
  ...CLOUD_GITHUB_PR_WRITES,
]);
export const CloudGithubPrResponseSchema = z
  .object({
    authority: CloudGithubPrAuthoritySchema,
    authorityCurrent: z.boolean().optional(),
    result: z.unknown(),
  })
  .strict();

/** Worker metadata only; cannot choose a different repository or credential. */
export const CloudGithubCheckoutSchema = z
  .object({
    sequence: z.number().int().positive().safe(),
    branch: branch.nullable(),
    baseBranch: branch,
    headSha: sha.nullable(),
  })
  .strict();

export type CloudGithubCheckout = z.infer<typeof CloudGithubCheckoutSchema>;
