import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { z } from "zod";
import {
  hunkReviewDecisionSchema,
  type HunkReviewDecision,
} from "@zeros/protocol/git-review-actions";
import { openZerosDb } from "../db/database";

// Engine-owned local metadata. Root hashing keeps rowless primary checkouts
// isolated without adding a foreign key to a synthetic workspace id. No source
// bytes or patch text are stored. This prefix is a persistence contract.
const PREFIX = "git.hunk-review.v1:";
const MAX_DECISIONS = 1024;
const recordsSchema = z.array(hunkReviewDecisionSchema).max(MAX_DECISIONS);
const storageKey = (cwd: string) =>
  PREFIX + createHash("sha256").update(realpathSync(cwd)).digest("hex");

function read(key: string): HunkReviewDecision[] {
  const row = openZerosDb()
    .prepare<
      [string],
      { value: string }
    >("SELECT value FROM settings WHERE key = ?")
    .get(key);
  if (!row || row.value.length > 1_500_000) return [];
  try {
    const result = recordsSchema.safeParse(JSON.parse(row.value));
    return result.success ? result.data : [];
  } catch {
    return [];
  }
}

export function listStoredHunkReviews(
  cwd: string,
  path: string,
): HunkReviewDecision[] {
  return read(storageKey(cwd)).filter((record) => record.path === path);
}

export function storeHunkReview(
  cwd: string,
  decision: HunkReviewDecision,
): HunkReviewDecision {
  const db = openZerosDb();
  const key = storageKey(cwd);
  return db.transaction(() => {
    const previous = read(key);
    const existing = previous.find((record) => record.key === decision.key);
    if (existing?.decision === decision.decision) return existing;
    const next = [
      ...previous.filter((record) => record.key !== decision.key),
      decision,
    ].slice(-MAX_DECISIONS);
    let encoded = JSON.stringify(next);
    while (encoded.length > 1_500_000 && next.length > 1) {
      next.shift();
      encoded = JSON.stringify(next);
    }
    db.prepare(
      "INSERT INTO settings (key, value, scope, rev, updated_at) VALUES (?, ?, 'local', 1, datetime('now')) ON CONFLICT(key) DO UPDATE SET value=excluded.value, scope='local', rev=settings.rev+1, updated_at=excluded.updated_at",
    ).run(key, encoded);
    return decision;
  })();
}
