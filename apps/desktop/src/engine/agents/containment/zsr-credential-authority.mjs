/** Preserve the policy's exact host:port authority through SRT credential
 * injection. Removing the port here would silently grant the secret to every
 * reachable service on the same host. */
export function credentialInjectionAuthorities(authorities) {
  return [...new Set(authorities)];
}

/** Render only issue codes and structural paths. Zod messages may echo config
 * values (hosts or local paths), so they never cross the supervisor boundary. */
export function schemaIssueSummary(error) {
  const issues = Array.isArray(error?.issues) ? error.issues : [];
  const summaries = issues.slice(0, 8).map((issue) => {
    const segments = Array.isArray(issue?.path) ? issue.path : [];
    const path = segments.reduce(
      (value, segment) =>
        typeof segment === "number"
          ? `${value}[${segment}]`
          : value
            ? `${value}.${String(segment)}`
            : String(segment),
      "",
    );
    const code =
      typeof issue?.code === "string" ? issue.code : "invalid_value";
    return `${path || "config"}:${code}`;
  });
  return [...new Set(summaries)].join(", ").slice(0, 512) || "config:invalid";
}
