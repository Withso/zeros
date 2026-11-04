import { createHash, randomUUID } from "node:crypto";
import {
  codeReviewActorSchema, codeReviewHumanActorCore, codeReviewFallbackName,
  type CodeReviewActor,
} from "@zeros/protocol/code-review";
import { openZerosDb } from "../db/database";
import { CodeReviewError, parseCodeReviewInput } from "./errors";

const LOCAL_ACTOR_KEY = "code-review.local-human.v1";
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const fallbackName = (id: string, local = false) => codeReviewFallbackName(id, hash, local);
export { codeReviewProfileName, codeReviewAgentActor } from "@zeros/protocol/code-review";

/** userId comes from verified transport claims, never operation arguments.
 * Offline desktops retain a device-local human identity across restarts. */
export function codeReviewHumanActor(userId?: string, remote = false, trustedName?: string): CodeReviewActor {
  if (userId) return codeReviewHumanActorCore(userId, hash, trustedName);
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
