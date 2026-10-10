/** Presentation copy for the two native organization-settings startup reasons.
 * Classification remains adapter-owned; never infer authentication from prose. */
export const CLAUDE_ORGANIZATION_STARTUP_MESSAGES = {
  org_config_required_unavailable: "Claude couldn't load your organization's required settings. Check your connection, then retry.",
  org_config_refused: "Your organization's Claude settings were refused for this sign-in. Sign in again or ask your administrator.",
} as const;

export function claudeOrganizationStartupMessage(code: string | undefined): string | undefined {
  return code && Object.hasOwn(CLAUDE_ORGANIZATION_STARTUP_MESSAGES, code)
    ? CLAUDE_ORGANIZATION_STARTUP_MESSAGES[code as keyof typeof CLAUDE_ORGANIZATION_STARTUP_MESSAGES]
    : undefined;
}

/** Adapter-generated advice has already been selected from a known reason.
 * Retain that reason in the existing optional notice code, alongside the native
 * message, so reloaded Local and cloud transcripts keep the same remedy. */
export function claudeOrganizationStartupCode(advice: string | undefined): string | undefined {
  return Object.entries(CLAUDE_ORGANIZATION_STARTUP_MESSAGES).find(([, message]) => message === advice)?.[0];
}
