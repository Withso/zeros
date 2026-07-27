// Type declarations for models-verify.mjs (plain Node ESM, no types of its own).
//
// The unit suite imports the validator from this script
// (src/zeros/agent/__tests__/models-catalog-validity.test.ts) so a bad catalog
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
