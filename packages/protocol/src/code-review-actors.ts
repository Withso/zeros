import { codeReviewActorSchema, type CodeReviewActor } from "./code-review-contract";
import { parseCodeReviewInput } from "./code-review-errors";

function displayName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const name = value.trim();
  const parsed = codeReviewActorSchema.shape.name.safeParse(name);
  return parsed.success ? parsed.data : undefined;
}
export const codeReviewFallbackName = (id: string, hash: (value: string) => string, local = false) => `${local ? "Local reviewer" : "Reviewer"} ${hash(id).slice(0, 8).toUpperCase()}`;

/** Only call with signature-verified account claims. Never use CONNECTED's
 * client metadata, an email address, or review operation arguments as a name. */
export function codeReviewProfileName(claims: Record<string, unknown>): string | undefined {
  return displayName(claims.name) ?? displayName([
    displayName(claims.first_name) ?? displayName(claims.given_name),
    displayName(claims.last_name) ?? displayName(claims.family_name),
  ].filter(Boolean).join(" "));
}

/** The caller supplies a verified account identity, never operation input. */
export function codeReviewHumanActorCore(userId: string, hash: (value: string) => string, trustedName?: string): CodeReviewActor {
  return parseCodeReviewInput(codeReviewActorSchema, {
    id: `human:${userId}`, name: displayName(trustedName) ?? codeReviewFallbackName(`human:${userId}`, hash), kind: "human",
  });
}

/** The provider and conversation/execution identities are engine admission
 * data. Agents cannot choose a human identity or override their provider. */
export function codeReviewAgentActor(input: { agentId?: string; executionId: string; conversationId?: string }): CodeReviewActor | null {
  const provider = input.agentId;
  if (provider !== "claude" && provider !== "codex" && provider !== "cursor") return null;
  return parseCodeReviewInput(codeReviewActorSchema, {
    id: `agent:${provider}:${input.conversationId ?? input.executionId}`,
    name: { claude: "Claude", codex: "Codex", cursor: "Cursor" }[provider],
    kind: "agent", provider,
  });
}
