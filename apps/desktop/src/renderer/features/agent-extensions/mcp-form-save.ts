import { draftError, newSecretsFromDraft, serverFromDraft, type Draft, type RawServer } from "./mcp-server-model";

export interface McpSecretChanges {
  env?: Record<string, string | null>;
  headers?: Record<string, string | null>;
  oauthClientSecret?: string | null;
}

export function mcpDraftError(draft: Draft, takenNames = new Set<string>()): string | null {
  const error = draftError(draft, takenNames);
  if (error) return error;
  if (draft.transport !== "stdio" && draft.auth === "header") {
    if (!draft.headers.some(row => row.key.trim())) return "Add at least one API key header.";
    const empty = draft.headers.find(row => row.key.trim() && !row.stored && !row.value.trim());
    if (empty) return `Enter a value for the ${empty.key.trim()} header.`;
  }
  return null;
}

export function secretChangesFromDraft(draft: Draft): McpSecretChanges {
  return {
    env: Object.fromEntries(newSecretsFromDraft(draft).map(row => [row.name, row.value])),
    ...(draft.transport !== "stdio" && draft.headers.length ? { headers: Object.fromEntries(draft.headers
      .filter(row => row.key.trim() && (!row.stored || row.value.length > 0))
      .map(row => [row.key.trim(), row.value])) } : {}),
    ...(draft.auth === "oauth" && draft.transport !== "stdio"
      ? (draft.oauthMode && draft.oauthMode !== "custom") || draft.clearOAuthClientSecret ? { oauthClientSecret: null }
        : draft.oauthClientSecret ? { oauthClientSecret: draft.oauthClientSecret } : {}
      : {}),
  };
}

/** One save path for both placements. Validation happens on submit, before any
 * credential write or configuration mutation. Backends own atomic persistence. */
export async function saveMcpDraft(input: {
  draft: Draft;
  initial: RawServer | null;
  takenNames: Set<string>;
  persist: (server: RawServer, secrets: McpSecretChanges) => Promise<void>;
}): Promise<void> {
  const error = mcpDraftError(input.draft, input.takenNames);
  if (error) throw new Error(error);
  await input.persist(serverFromDraft(input.draft, input.initial), secretChangesFromDraft(input.draft));
}
