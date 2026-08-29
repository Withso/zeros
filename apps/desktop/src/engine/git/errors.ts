// Typed errors for the git + GitHub integration layer. Every IPC command
// either returns a structured result or throws a GitError. Renderers pattern-
// match on `code` to decide UX (e.g. BRANCH_IN_USE → offer the three-option
// resolution dialog).

export type GitErrorCode =
  | "BRANCH_IN_USE"
  | "NOT_AUTHENTICATED"
  | "NETWORK_ERROR"
  | "NOT_A_REPO"
  | "WORKTREE_NOT_FOUND"
  // The workspace row exists but its worktree FOLDER is gone from disk. Distinct
  // from WORKTREE_NOT_FOUND (a git-admin miss): the record is intact, the
  // checkout is not. Archiving one is refused — there's nothing to stash/remove
  // and a later restore would fabricate a phantom worktree; the renderer offers
  // permanent deletion instead.
  | "WORKTREE_MISSING"
  | "WORKSPACE_NOT_FOUND"
  | "WORKSPACE_ALREADY_EXISTS"
  | "MERGE_IN_PROGRESS"
  | "REBASE_IN_PROGRESS"
  | "VALIDATION_FAILED"
  | "STASH_FAILED"
  | "DETACH_LOCKED"
  | "DETACH_NOT_ACTIVE"
  | "GIT_COMMAND_FAILED"
  | "GITHUB_API_ERROR"
  | "GITHUB_RATE_LIMITED"
  | "GITHUB_SSO_REQUIRED"
  | "GITHUB_FORBIDDEN_SCOPE"
  | "GITHUB_REPO_NOT_INSTALLED"
  | "GITHUB_INSTALLATION_SUSPENDED"
  | "SETUP_SCRIPT_FAILED"
  | "CONTAINMENT_TEARDOWN_FAILED"
  | "REMOTE_RESTRICTED"
  | "REMOTE_PATH_DENIED"
  // Settings TOML ops (apps/desktop/src/engine/settings/ops.ts — surfaced via the same
  // WORKSPACE_ERROR envelope as every other workspace op).
  | "SETTINGS_BAD_LAYER"
  | "SETTINGS_BAD_PATCH"
  | "SETTINGS_BAD_TOML"
  | "SETTINGS_REPO_REQUIRED"
  | "SETTINGS_REDACTED_VALUE"
  | "SETTINGS_REMOTE_KEY_DENIED"
  | "MCP_GATEWAY_DOWN"
  | "SETTINGS_REMOTE_SECRET_ENV";

export interface GitErrorOptions {
  code: GitErrorCode;
  message: string;
  cause?: unknown;
  remediation?: string;
  /** Extra context attached for renderer consumption — e.g. for
   *  BRANCH_IN_USE we attach { branch, heldBy: { path, tool } } so the
   *  renderer can render the resolution dialog without a second roundtrip. */
  context?: Record<string, unknown>;
}

export class GitError extends Error {
  readonly code: GitErrorCode;
  readonly cause?: unknown;
  readonly remediation?: string;
  readonly context?: Record<string, unknown>;

  constructor(opts: GitErrorOptions) {
    super(opts.message);
    this.name = "GitError";
    this.code = opts.code;
    this.cause = opts.cause;
    this.remediation = opts.remediation;
    this.context = opts.context;
  }

  /** Renderer-shaped serialization. IPC strips Error prototypes when
   *  serializing across the bridge, so we manually expose a plain object
   *  that the renderer can consume without losing structured fields. */
  toJSON(): {
    name: "GitError";
    code: GitErrorCode;
    message: string;
    remediation?: string;
    context?: Record<string, unknown>;
    causeMessage?: string;
  } {
    return {
      name: "GitError",
      code: this.code,
      message: this.message,
      remediation: this.remediation,
      context: this.context,
      causeMessage:
        this.cause instanceof Error ? this.cause.message : undefined,
    };
  }
}

export function isGitError(err: unknown): err is GitError {
  return err instanceof GitError;
}

// Git flag-injection guarding for ref/branch/remote args lives in
// `assertSafeGitRef` (git-exec.ts) — a strict superset of the old
// `assertSafeRefArg` (also rejects empty/non-string and NUL bytes).
