import { createHash, randomUUID } from "node:crypto";
import {
  codeReviewActorSchema,
  type CodeReviewActor,
} from "@zeros/protocol/code-review";
import { openZerosDb } from "../db/database";
import { CodeReviewError, parseCodeReviewInput } from "./errors";

const LOCAL_ACTOR_KEY = "code-review.local-human.v1";
function displayName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const name = value.trim();
  const parsed = codeReviewActorSchema.shape.name.safeParse(name);
  return parsed.success ? parsed.data : undefined;
}
const fallbackName = (id: string, local = false) => `${local ? "Local reviewer" : "Reviewer"} ${createHash("sha256").update(id).digest("hex").slice(0, 8).toUpperCase()}`;

/** Only call with signature-verified account claims. Never use CONNECTED's
 * client metadata, an email address, or review operation arguments as a name. */
export function codeReviewProfileName(claims: Record<string, unknown>): string | undefined {
  return displayName(claims.name) ?? displayName([
    displayName(claims.first_name) ?? displayName(claims.given_name),
    displayName(claims.last_name) ?? displayName(claims.family_name),
  ].filter(Boolean).join(" "));
}

/** userId comes from verified transport claims, never operation arguments.
 * Offline desktops retain a device-local human identity across restarts. */
export function codeReviewHumanActor(userId?: string, remote = false, trustedName?: string): CodeReviewActor {
  if (userId) return parseCodeReviewInput(codeReviewActorSchema, {
    id: `human:${userId}`, name: displayName(trustedName) ?? fallbackName(`human:${userId}`), kind: "human",
  });
  if (remote) throw new CodeReviewError("CODE_REVIEW_AUTHORITY_REJECTED", "A verified workspace identity is required to write review comments.");
  const db = openZerosDb();
  return db.transaction(() => {
    const id = `human:local:${randomUUID()}`;
    db.prepare("INSERT OR IGNORE INTO settings (key, value, scope) VALUES (?, ?, 'local')")
      .run(LOCAL_ACTOR_KEY, JSON.stringify({ id, name: fallbackName(id, true), kind: "human" }));
    const row = db.prepare("SELECT value FROM settings WHERE key = ? AND scope = 'local'").get(LOCAL_ACTOR_KEY) as { value: string } | undefined;
    if (!row) throw new CodeReviewError("CODE_REVIEW_AUTHORITY_REJECTED", "The local review identity is unavailable.");
    const actor = parseCodeReviewInput(codeReviewActorSchema, JSON.parse(row.value));
    return actor.name === "Local user" ? { ...actor, name: fallbackName(actor.id, true) } : actor;
  })();
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
