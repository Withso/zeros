import { canonicalResourceUri } from "./oauth-url";

/** Resource, settings owner and opaque server identity all bind credentials.
 * The old URI-only key remains readable only for an existing user-wide entry. */
export function mcpCredentialKey(id: string | undefined, url?: string, repoRoot?: string): string {
  const resource = url ? canonicalResourceUri(url) : "stdio";
  return !id && !repoRoot ? resource : JSON.stringify(["mcp", repoRoot ?? "user", id ?? resource, resource]);
}
