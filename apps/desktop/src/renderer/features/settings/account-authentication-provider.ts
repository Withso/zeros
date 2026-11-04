export type AccountAuthenticationProvider =
  | "github"
  | "google"
  | "email-code";

export function accountAuthenticationProvider(
  authenticationMethod: string | null | undefined,
): AccountAuthenticationProvider | null {
  if (authenticationMethod === "GitHubOAuth") return "github";
  if (authenticationMethod === "GoogleOAuth") return "google";
  if (authenticationMethod === "MagicAuth") return "email-code";
  return null;
}

export function accountAuthenticationProviderLabel(
  provider: AccountAuthenticationProvider | null,
): string | null {
  if (provider === "github") return "GitHub";
  if (provider === "google") return "Google";
  if (provider === "email-code") return "Email code";
  return null;
}
