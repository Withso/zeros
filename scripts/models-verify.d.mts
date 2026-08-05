// Type declarations for models-verify.mjs (plain Node ESM, no types of its own).
//
// The unit suite imports the validator from this script
// (apps/desktop/src/renderer/features/agent/__tests__/models-catalog-validity.test.ts) so a bad catalog
// edit fails the suite. Under the strict typecheck (tsconfig.typecheck.json) that
// import otherwise errors TS7016 ("implicitly has an 'any' type") and the
// downstream `.some((w) => ...)` callback param errors TS7006. These declarations
// give the two exported validators real signatures so the typecheck is sound.
//
// Keep in sync with scripts/models-verify.mjs's exports.

export interface CatalogValidation {
  /** Structural / consistency errors. Non-empty => `models:verify` exits non-zero. */
  errors: string[];
  /** Non-fatal warnings (e.g. CLI-version gate, live drift). */
  warnings: string[];
}

/** Pure structural + consistency validation of the curated model catalog. */
export function validateCatalog(catalog: unknown): CatalogValidation;

/** Warnings for curated models whose `minCliVersion` exceeds `cliVersion`. */
export function checkCliVersionGate(
  catalog: unknown,
  cliVersion: string,
): string[];

/** The bundled claude-code CLI version from the LINKED (active) agent SDK —
 *  its declared `claudeCodeVersion`, falling back to manifest.json. `null` when
 *  the SDK isn't installed / can't be read. Pair with {@link checkCliVersionGate}
 *  to assert every curated model is runnable on the PINNED SDK. */
export function bundledClaudeCliVersion(): string | null;

/** Distinct model-id-shaped literals in a binary, streamed. `null` when the path
 *  can't be opened. */
export function scanModelIds(binaryPath: string, re?: RegExp): Set<string> | null;

/** The model ids the PINNED Claude CLI knows, read off the real platform binary.
 *  `null` when that binary isn't installed for this os/cpu (it's an OPTIONAL
 *  dependency, so `--no-optional` installs legitimately lack it). */
export function knownClaudeModelIds(): Set<string> | null;

export interface ModelIdExistenceResult {
  /** Curated ids the bundled CLI has never heard of. Gates under `--strict`. */
  missing: string[];
  /** Never gates: an unresolved binary or an inconclusive scan. */
  notes: string[];
}

/** Curated claude models whose id the bundled CLI does not know — the RETIRED
 *  direction, which {@link checkCliVersionGate} cannot see because retiring an id
 *  bumps no version. */
export function checkModelIdsKnownToCli(
  catalog: unknown,
  knownIds: Set<string> | null,
): ModelIdExistenceResult;
