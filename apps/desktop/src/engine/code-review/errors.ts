import type { z } from "zod";

export class CodeReviewError extends Error {
  constructor(readonly code:
    | "CODE_REVIEW_INVALID"
    | "CODE_REVIEW_NOT_FOUND"
    | "CODE_REVIEW_STALE"
    | "CODE_REVIEW_RETRY_CONFLICT"
    | "CODE_REVIEW_PATH_DENIED"
    | "CODE_REVIEW_AUTHORITY_REJECTED", message: string) {
    super(message);
    this.name = "CodeReviewError";
  }
}

/** Do not put a body, context, author, or host path in boundary errors/logs. */
export function parseCodeReviewInput<T>(schema: z.ZodType<T>, raw: unknown): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new CodeReviewError("CODE_REVIEW_INVALID", "Invalid code review input. Check the file path, line range, comment, and version.");
  return parsed.data;
}
