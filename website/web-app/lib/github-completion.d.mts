export const GITHUB_COMPLETION_SCHEMES: readonly string[];
export const GITHUB_COMPLETION_ERRORS: readonly string[];
export const GITHUB_COMPLETION_LINK_TTL_MS: number;

export type GithubCompletionFragment =
  | { kind: "connected"; deepLink: string }
  | { kind: "error"; error: string; deepLink: string }
  | { kind: "invalid" };

export function parseGithubCompletionFragment(
  rawFragment: string,
  allowedSchemes: readonly string[],
  allowedErrors: readonly string[],
): GithubCompletionFragment;

interface GithubCompletionTextElement {
  textContent: string | null;
}

interface GithubCompletionLinkElement {
  hidden: boolean;
  removeAttribute(name: string): void;
}

export function armGithubCompletionExpiry(
  parsed: GithubCompletionFragment,
  elements: {
    title: GithubCompletionTextElement;
    sub: GithubCompletionTextElement;
    open: GithubCompletionLinkElement;
    msg: GithubCompletionTextElement;
  },
  schedule: (callback: () => void, timeoutMs: number) => unknown,
  timeoutMs: number,
): () => void;
