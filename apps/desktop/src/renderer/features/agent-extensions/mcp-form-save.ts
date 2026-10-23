import { draftError, newSecretsFromDraft, serverFromDraft, type Draft, type RawServer } from "./mcp-server-model";

export interface McpSecretChanges {
  env?: Record<string, string | null>;
  headers?: Record<string, string | null>;
  oauthClientSecret?: string | null;
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
  const error = draftError(input.draft, input.takenNames);
  if (error) throw new Error(error);
  if (input.draft.auth === "header" && input.draft.transport !== "stdio" && !input.draft.headers.some(row => row.key.trim())) throw new Error("Add at least one API key header.");
  await input.persist(serverFromDraft(input.draft, input.initial), secretChangesFromDraft(input.draft));
}
