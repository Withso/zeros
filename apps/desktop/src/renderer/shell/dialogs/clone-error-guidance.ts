import { isGitErrorShape } from "../../platform/git";

export function cloneErrorGuidance(
  error: unknown,
  placement: "local" | "cloud",
): string | null {
  if (placement !== "local" || !isGitErrorShape(error)) return null;

  switch (error.code) {
    case "NOT_AUTHENTICATED":
      return "Check credentials for the repository host and confirm the account can access the repository, then try again.";
    case "NETWORK_ERROR":
      return "Couldn't reach the repository host. Check your connection, then try again.";
    default:
      return null;
  }
}
