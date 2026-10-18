/** Enable catalog/lifecycle poll replacement only after fixture and owner-org
 * conformance. Current server coverage is still required independently.
 * Presence replacement has a separate engine lifecycle prerequisite. */
export function cloudCatalogStreamRolloutEnabled(): boolean { return false; }
