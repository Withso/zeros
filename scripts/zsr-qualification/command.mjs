export function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

/** Build one shell program for the qualification child. Resource-limit helpers
 * are shell declarations, so only the final executable may be prefixed with
 * `exec`; putting `exec` before the prelude makes debug mode invalid syntax. */
export function buildQualificationCommand(options) {
  const target = `${options.resourcePrelude}${options.environmentPrelude}exec ${options.argv
    .map(shellQuote)
    .join(" ")}`;
  if (!options.debug || options.diagnostics.length === 0) return target;
  return `${options.diagnostics.join("; ")}; ${target}`;
}
