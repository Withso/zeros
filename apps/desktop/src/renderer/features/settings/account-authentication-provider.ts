export type AccountAuthenticationProvider =
  | "github"
  | "google"
  | "email-code";

function providerFromLegacySubject(
  subject: string | null | undefined,
): "github" | "google" | null {
  if (!subject) return null;
  if (subject.startsWith("github|")) return "github";
  if (subject.startsWith("google-oauth2|")) return "google";
  return null;
}

export function accountAuthenticationProvider(
  authenticationMethod: string | null | undefined,
  legacySubject: string | null | undefined,
): AccountAuthenticationProvider | null {
  if (authenticationMethod === "GitHubOAuth") return "github";
  if (authenticationMethod === "GoogleOAuth") return "google";
  if (authenticationMethod === "MagicAuth") return "email-code";
  return providerFromLegacySubject(legacySubject);
}

export function accountAuthenticationProviderLabel(
  provider: AccountAuthenticationProvider | null,
): string | null {
  if (provider === "github") return "GitHub";
  if (provider === "google") return "Google";
  if (provider === "email-code") return "Email code";
  return null;
}
