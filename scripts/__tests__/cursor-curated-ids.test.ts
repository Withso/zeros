// The curated-cursor-id resolution rule used by cursor-host-smoke.mjs's
// `--require-models` check (the scheduled `cursor-models` job).
//
// WHAT THIS GUARDS
// The check used to compare each curated id VERBATIM against `Cursor.models.list`.
// That is wrong in principle, because a curated id need not be a live id: the
// catalog curates `grok-4.5` as a level-free base so the Effort pill can pick the
// level, and applyCursorReasoning (adapter.ts §3.6 R1) completes such a base
// against the same live catalog before anything spawns. A base whose suffixed
// variants are live therefore works fine for users, and failing on it would be a
// false red in a job that runs weekly with a secret.
//
// NOT a bug observed in production: as of 2026-07-31 the live catalog does offer a
// bare `grok-4.5`, so the "exact" arm is what fires today (see LIVE_TODAY). The
// suffixed arm covers the shape the adapter already handles, which no version
// number would announce.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
// @ts-expect-error — .mjs has no type declarations; it exports one plain function.
import { resolvesAgainst } from "../cursor-curated-ids.mjs";

const ROOT = path.resolve(__dirname, "..", "..");

/** The catalog as the account actually reports it today: `grok-4.5` bare, with no
 *  suffixed grok ids at all. Verified against a real key on 2026-07-31. */
const LIVE_TODAY = new Set([
  "composer-2",
  "composer-2.5",
  "grok-4.5",
]);

/** The shape the adapter's R1 branch exists for: the base is gone and only
 *  level-suffixed variants remain. HYPOTHETICAL today — kept because the switch
 *  from one shape to the other bumps no version number. */
const LIVE_SUFFIXED_ONLY = new Set([
  "composer-2.5",
  "grok-4.5-low",
  "grok-4.5-medium",
  "grok-4.5-high",
  "grok-4.5-xhigh",
]);

describe("resolvesAgainst", () => {
  it("accepts an id the account offers verbatim", () => {
    expect(resolvesAgainst("composer-2.5", LIVE_TODAY)).toBe("exact");
    expect(resolvesAgainst("grok-4.5", LIVE_TODAY)).toBe("exact");
  });

  it("accepts a level-free base that survives only as suffixed variants", () => {
    // The verbatim comparison returned false here and reported a working model as
    // retired — under --require-models, a hard failure.
    expect(resolvesAgainst("grok-4.5", LIVE_SUFFIXED_ONLY)).toBe("suffixed");
  });

  it("rejects an id with neither an exact nor a suffixed match", () => {
    // A genuinely retired base leaves no `<base>-…` ids behind either, which is
    // what keeps the loosened rule a real check rather than a rubber stamp.
    expect(resolvesAgainst("composer-1", LIVE_TODAY)).toBe(false);
    expect(resolvesAgainst("grok-3", LIVE_SUFFIXED_ONLY)).toBe(false);
  });

  it("requires the separator — a base is not certified by a longer sibling", () => {
    // `grok-4` must NOT pass on the strength of `grok-4.5`: different models. This
    // is the false-PASS direction, so it matters more than the false-fail above.
    expect(resolvesAgainst("grok-4", LIVE_TODAY)).toBe(false);
    expect(resolvesAgainst("composer-2.", LIVE_TODAY)).toBe(false);
  });

  it("rejects an empty catalog rather than certifying everything", () => {
    // The smoke treats an empty models.list as inconclusive before it gets here;
    // this is the belt-and-braces half of that.
    expect(resolvesAgainst("composer-2.5", new Set())).toBe(false);
  });

  it("rejects a missing or non-string id instead of throwing", () => {
    // The caller maps `m.value` out of the catalog, so a renamed key yields
    // undefined — the gate must report that, not crash.
    expect(resolvesAgainst("", LIVE_TODAY)).toBe(false);
    expect(resolvesAgainst(undefined, LIVE_TODAY)).toBe(false);
  });

  it("every id curated for cursor today resolves under BOTH catalog shapes", () => {
    // The shipped catalog against the real shape and the suffixed-only one. Fails
    // if a future curated id is neither live nor completable — here, in unit tests,
    // instead of weekly in the keyed job.
    const catalog = JSON.parse(
      readFileSync(path.join(ROOT, "catalogs", "models-v1.json"), "utf-8"),
    ) as { families: { cursor: Array<{ value: string }> } };
    const curated = catalog.families.cursor.map((m) => m.value);

    expect(curated.length).toBeGreaterThan(0); // an empty list would prove nothing
    for (const id of curated) {
      expect(resolvesAgainst(id, LIVE_TODAY), `${id} vs today`).toBeTruthy();
      expect(
        resolvesAgainst(id, LIVE_SUFFIXED_ONLY),
        `${id} vs suffixed-only`,
      ).toBeTruthy();
    }
  });
});
