// The curated-cursor-id resolution rule used by cursor-host-smoke.mjs's
// `--require-models` check (the scheduled `cursor-models` job).
//
// WHAT THIS GUARDS
// The check used to compare each curated id VERBATIM against `Cursor.models.list`.
// That is wrong in principle, because a curated id need not be a live id: the
// catalog curates `grok-4.5` as a level-free base so the Effort pill can pick the
// level, and applyCursorReasoning completes such a base
// against the same live catalog before anything spawns. A base whose suffixed
// variants are live therefore works fine for users, and failing on it would be a
// false red in a job that runs weekly with a secret.
//
// Account catalogs differ: the current fixture does not offer Grok 4.5, while a
// legacy fixture does. The suffixed arm covers another shape the adapter already
// handles, which no package version would announce.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
// @ts-expect-error — .mjs has no type declarations; it exports one plain function.
import { qualifiesAgainst, resolvesAgainst } from "../cursor-curated-ids.mjs";

const ROOT = path.resolve(__dirname, "..", "..");

/** One current @cursor/sdk 1.0.31 account response. Grok 4.5 is
 * account-dependent compatibility data, not assumed globally retired. */
const CURRENT_ACCOUNT = new Set([
  "default",
  "composer-2",
  "composer-2.5",
  "grok-4.6",
]);

const LEGACY_ACCOUNT = new Set([...CURRENT_ACCOUNT, "grok-4.5"]);

/** The shape the adapter's suffixed fallback exists for: the base is gone and only
 *  level-suffixed variants remain. HYPOTHETICAL today — kept because the switch
 *  from one shape to the other bumps no version number. */
const LIVE_SUFFIXED_ONLY = new Set([
  "composer-2.5",
  "default",
  "grok-4.6-low",
  "grok-4.6-medium",
  "grok-4.6-high",
  "grok-4.6-xhigh",
  "grok-4.5-low",
  "grok-4.5-medium",
  "grok-4.5-high",
  "grok-4.5-xhigh",
]);

describe("resolvesAgainst", () => {
  it("accepts an id the account offers verbatim", () => {
    expect(resolvesAgainst("composer-2.5", CURRENT_ACCOUNT)).toBe("exact");
    expect(resolvesAgainst("grok-4.5", LEGACY_ACCOUNT)).toBe("exact");
  });

  it("accepts a level-free base that survives only as suffixed variants", () => {
    // The verbatim comparison returned false here and reported a working model as
    // retired — under --require-models, a hard failure.
    expect(resolvesAgainst("grok-4.5", LIVE_SUFFIXED_ONLY)).toBe("suffixed");
  });

  it("rejects an id with neither an exact nor a suffixed match", () => {
    // A genuinely retired base leaves no `<base>-…` ids behind either, which is
    // what keeps the loosened rule a real check rather than a rubber stamp.
    expect(resolvesAgainst("composer-1", CURRENT_ACCOUNT)).toBe(false);
    expect(resolvesAgainst("grok-3", LIVE_SUFFIXED_ONLY)).toBe(false);
  });

  it("requires the separator — a base is not certified by a longer sibling", () => {
    // `grok-4` must NOT pass on the strength of `grok-4.5`: different models. This
    // is the false-PASS direction, so it matters more than the false-fail above.
    expect(resolvesAgainst("grok-4", LEGACY_ACCOUNT)).toBe(false);
    expect(resolvesAgainst("composer-2.", LEGACY_ACCOUNT)).toBe(false);
  });

  it("rejects an empty catalog rather than certifying everything", () => {
    // The smoke treats an empty models.list as inconclusive before it gets here;
    // this is the belt-and-braces half of that.
    expect(resolvesAgainst("composer-2.5", new Set())).toBe(false);
  });

  it("rejects a missing or non-string id instead of throwing", () => {
    // The caller maps `m.value` out of the catalog, so a renamed key yields
    // undefined — the gate must report that, not crash.
    expect(resolvesAgainst("", CURRENT_ACCOUNT)).toBe(false);
    expect(resolvesAgainst(undefined, CURRENT_ACCOUNT)).toBe(false);
  });

  it("allows only explicitly optional models to be absent for a current account", () => {
    expect(
      qualifiesAgainst(
        { value: "grok-4.5", liveRequired: true },
        CURRENT_ACCOUNT,
      ),
    ).toBe("optional-unavailable");
    expect(
      qualifiesAgainst(
        { value: "grok-4.5", liveRequired: false },
        CURRENT_ACCOUNT,
      ),
    ).toBe(false);
    expect(
      qualifiesAgainst(
        { value: "grok-4.5", liveRequired: true },
        LEGACY_ACCOUNT,
      ),
    ).toBe("exact");
    expect(qualifiesAgainst({ liveRequired: true }, CURRENT_ACCOUNT)).toBe(
      false,
    );
  });

  it("qualifies the shipped catalog for both current and legacy account fixtures", () => {
    const catalog = JSON.parse(
      readFileSync(path.join(ROOT, "catalogs", "models-v1.json"), "utf-8"),
    ) as {
      families: {
        cursor: Array<{ value: string; liveRequired?: boolean }>;
      };
    };
    const curated = catalog.families.cursor;

    expect(curated.length).toBeGreaterThan(0); // an empty list would prove nothing
    for (const model of curated) {
      expect(
        qualifiesAgainst(model, CURRENT_ACCOUNT),
        `${model.value} vs current account`,
      ).toBeTruthy();
      expect(
        qualifiesAgainst(model, LEGACY_ACCOUNT),
        `${model.value} vs legacy account`,
      ).toBeTruthy();
      expect(
        qualifiesAgainst(model, LIVE_SUFFIXED_ONLY),
        `${model.value} vs legacy suffixed-only`,
      ).toBeTruthy();
    }
  });
});
