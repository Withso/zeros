export const GITHUB_COMPLETION_SCHEMES: readonly string[];
export const GITHUB_COMPLETION_ERRORS: readonly string[];

export type GithubCompletionFragment =
  | { kind: "connected"; deepLink: string }
  | { kind: "error"; error: string; deepLink: string }
  | { kind: "invalid" };

export function parseGithubCompletionFragment(
  rawFragment: string,
  allowedSchemes: readonly string[],
  allowedErrors: readonly string[],
): GithubCompletionFragment;
