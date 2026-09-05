// ──────────────────────────────────────────────────────────
// cursor-curated-ids — does a curated cursor model id still resolve?
// ──────────────────────────────────────────────────────────
//
// Used by cursor-host-smoke.mjs's `--require-models` check (the scheduled
// `cursor-models` job), which compares catalogs/models-v1.json's `families.cursor`
// against the ids `Cursor.models.list` reports for a real account. Its own module
// so the rule below — which mirrors engine logic and will drift with it — is unit
// testable; the smoke itself spawns a subprocess at import time and so cannot be
// imported by a test.
// ──────────────────────────────────────────────────────────

/** How a curated id resolves against the account's live catalog:
 *    "exact"    — offered verbatim
 *    "suffixed" — only a `<id>-…` variant is offered
 *    false      — neither; the pick resolves to nothing this account can run
 *
 *  WHY "suffixed" COUNTS
 *  A curated id is not required to BE a live id. The catalog curates `grok-4.5` as
 *  a LEVEL-FREE base so the Effort pill can choose the level, and the adapter
 *  completes such a base against this same live catalog BEFORE anything spawns:
 *  applyCursorReasoning in the adapter tries `<base>-<level>`,
 *  `<base>-thinking-<level>` and `<base>-fast…`, falling back to the `-xhigh` top
 *  tier, and only when `available.has(base)` is false. So the question this gate
 *  must ask is "can the adapter still resolve this pick to something the account
 *  runs?", not "is the string present?" — a base whose suffixed variants are live
 *  works fine for users, and failing the build over it would be a false red under
 *  `--require-models`.
 *
 *  ACCOUNT NOTE: model availability differs by Cursor account. A legacy account
 *  may offer a bare `grok-4.5`, another may expose only suffixed variants, and a
 *  current account may offer neither. The catalog marks such compatibility rows
 *  `liveRequired`; {@link qualifiesAgainst} makes only that explicit absence
 *  optional without weakening the required-model check.
 *
 *  `<id>-` as the test, rather than enumerating the level/fast shapes, is
 *  deliberate: every candidate applyCursorReasoning builds is `${base}-…`, so this
 *  stays correct when Cursor adds a level or renames a suffix. It is still a real
 *  check — a genuinely retired base leaves no `<base>-…` ids behind either, which
 *  is the failure the gate exists to catch.
 *
 *  A prefix match, NOT a substring one: the trailing `-` is what stops `grok-4`
 *  from being certified by `grok-4.5`, which is a DIFFERENT model.
 *
 *  Deliberately NOT shared with codex-app-server-smoke.mjs, whose curated ids are
 *  every one of them live and are compared verbatim. Loosening that check to match
 *  this one would let a retired codex id pass on the strength of an unrelated
 *  suffixed sibling. The asymmetry is the point: cursor curates a base it may not
 *  be able to run directly, codex does not. */
export function resolvesAgainst(id, live) {
  if (typeof id !== "string" || id.length === 0) return false;
  if (live.has(id)) return "exact";
  for (const candidate of live) {
    if (typeof candidate === "string" && candidate.startsWith(`${id}-`)) {
      return "suffixed";
    }
  }
  return false;
}

/** Qualify one catalog record against an account response. `liveRequired` means
 * account-dependent availability: absence is allowed, but a present exact or
 * suffixed form is still verified through the same resolution rule. */
export function qualifiesAgainst(model, live) {
  if (
    !model ||
    typeof model !== "object" ||
    typeof model.value !== "string" ||
    model.value.length === 0
  ) {
    return false;
  }
  const resolution = resolvesAgainst(model.value, live);
  if (resolution) return resolution;
  return model.liveRequired === true ? "optional-unavailable" : false;
}
