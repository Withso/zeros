/** Preserve exact host:port authorities for credential substitution. */
export function credentialInjectionAuthorities(
  authorities: readonly string[],
): string[];

/** Render a bounded, value-free summary of a schema-validation failure. */
export function schemaIssueSummary(error: unknown): string;
