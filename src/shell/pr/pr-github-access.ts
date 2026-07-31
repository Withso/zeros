// ──────────────────────────────────────────────────────────
// pr-github-access — one honest sentence for "GitHub won't let you PR this"
// ──────────────────────────────────────────────────────────
//
// Every route into a failed pull request converges here so the user reads the
// same diagnosis whichever one they took: the up-front access preflight, the
// engine's own gh.prCreate rejection, and the refusal that gates the agent
// brief.
//
// The distinction this module exists to make is `connected`. GitHub reports
// "you are not signed in" and "you are signed in, but this repository is
// outside your connection's reach" with the SAME 404, and `git push` reports
// the second one as "remote: Repository not found" — which the transport
// classifier must read as NOT_AUTHENTICATED for the credential-rotation retry
// to fire. Mapping that code straight to "Connect GitHub" told a user with a
// working GitHub App connection to go and connect GitHub.
//
// Pure — no imports, no I/O — so the copy is unit-tested directly.
// ──────────────────────────────────────────────────────────

/** The subset of a GithubRepoAccess / GitErrorShape this module reads. */
export interface PrAccessFacts {
  code?: string;
  message?: string;
  remediation?: string;
  /** Whether a GitHub credential is selected and readable. `undefined` means
   *  we never found out, which is treated as "don't claim they're signed in". */
  connected?: boolean;
}

export interface PrBlockMessage {
  title: string;
  description: string;
  /** Is Settings → Integrations the useful next step? False for problems no
   *  amount of reconnecting fixes (no remote, a non-github.com host). */
  openSettings: boolean;
}

const CONNECT_DESCRIPTION =
  "Choose an authentication method in Settings → Integrations to continue.";

/** Codes where the fix lives in Settings → Integrations. Mirrors the set the
 *  engine treats as a definite access refusal (BLOCKING_ACCESS_CODES). */
const SETTINGS_CODES = new Set([
  "NOT_AUTHENTICATED",
  "GITHUB_SSO_REQUIRED",
  "GITHUB_FORBIDDEN_SCOPE",
  "GITHUB_REPO_NOT_INSTALLED",
  "GITHUB_INSTALLATION_SUSPENDED",
]);

export function needsGithubSettings(code: string | undefined): boolean {
  return code !== undefined && SETTINGS_CODES.has(code);
}

function detail(facts: PrAccessFacts, fallback: string): string {
  return facts.remediation?.trim() || facts.message?.trim() || fallback;
}

/** Turn a definite GitHub refusal into the toast the Create PR control shows. */
export function describePrAccessBlock(facts: PrAccessFacts): PrBlockMessage {
  const code = facts.code;
  if (code === "NOT_AUTHENTICATED") {
    // Only claim "not signed in" when we actually know nothing is connected.
    return facts.connected === true
      ? {
          title: "GitHub refused this connection",
          description:
            "Reconnect GitHub in Settings → Integrations, or grant the connected account access to this repository.",
          openSettings: true,
        }
      : {
          title: "Connect GitHub to create this pull request",
          description: CONNECT_DESCRIPTION,
          openSettings: true,
        };
  }
  if (code === "GITHUB_REPO_NOT_INSTALLED") {
    return {
      title: "Your GitHub connection can't reach this repository",
      description: detail(
        facts,
        "Grant the connection access to this repository, or check that the remote points at the right one.",
      ),
      openSettings: true,
    };
  }
  if (code === "GITHUB_FORBIDDEN_SCOPE") {
    return {
      title: "Your GitHub connection can't open a pull request here",
      description: detail(
        facts,
        "Update the connection's repository permissions on GitHub, then try again.",
      ),
      openSettings: true,
    };
  }
  if (code === "GITHUB_SSO_REQUIRED") {
    return {
      title: "This organization needs GitHub sign-in",
      description: detail(
        facts,
        "Authorize this connection with your organization on GitHub, then try again.",
      ),
      openSettings: true,
    };
  }
  if (code === "GITHUB_INSTALLATION_SUSPENDED") {
    return {
      title: "This GitHub App installation is suspended",
      description: detail(
        facts,
        "Ask the account owner who suspended the installation to restore it on GitHub.",
      ),
      openSettings: true,
    };
  }
  // Everything else that blocks is a repository-shaped problem (no configured
  // remote, a host that isn't github.com) whose fix is in the repo, not in
  // Settings — so no button that would send the user somewhere useless.
  return {
    title: "Couldn't create pull request",
    description: detail(facts, "GitHub refused this pull request."),
    openSettings: needsGithubSettings(code),
  };
}

/** The message for an operation that already FAILED. `access` is the preflight
 *  that ran alongside it: when the probe reached a verdict it is the better
 *  witness, because the engine's own failure can be the ambiguous
 *  push-said-not-found flavour of NOT_AUTHENTICATED. */
export function describePrCreateFailure(
  error: PrAccessFacts | null | undefined,
  access?: { state?: string } & PrAccessFacts,
): PrBlockMessage {
  if (access?.state === "blocked") return describePrAccessBlock(access);
  const facts: PrAccessFacts = {
    ...(error ?? {}),
    // The probe is the only thing that knows whether a credential exists at
    // all; an engine GitError never carries it.
    ...(access?.connected !== undefined ? { connected: access.connected } : {}),
  };
  if (facts.code && SETTINGS_CODES.has(facts.code)) {
    return describePrAccessBlock(facts);
  }
  return {
    title: "Couldn't create pull request",
    description: detail(facts, "GitHub refused this pull request."),
    openSettings: false,
  };
}
