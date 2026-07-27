import type {
  PR,
  PrChecksResult,
  StatusResult,
} from "../../native/git";

export interface PrPushGenerationInput {
  status: StatusResult | null;
  pr: PR | null;
  checks: PrChecksResult | null;
}

/** Fields for the post-push renderer snapshot. Local ahead/behind are from the
 *  completed push, while every GitHub-derived field becomes unknown until one
 *  exact new-head batch settles. */
export function optimisticPushGeneration(
  data: PrPushGenerationInput,
  pushed: { ahead: number; behind: number },
  at: number = Date.now(),
): PrPushGenerationInput & { at: number } {
  return {
    status: data.status
      ? {
          ...data.status,
          ahead: pushed.ahead,
          behind: pushed.behind,
        }
      : null,
    pr: data.pr
      ? {
          ...data.pr,
          mergeableState: "unknown",
          isMergeable: null,
          behindBy: null,
        }
      : null,
    checks: null,
    at,
  };
}
