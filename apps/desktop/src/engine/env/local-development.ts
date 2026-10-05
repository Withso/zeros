/** Local admission belongs to the desktop/engine, never a user subprocess. */
export function withoutLocalDevelopment<
  T extends Record<string, string | undefined>,
>(env: T): T {
  if (!("ZEROS_LOCAL_DEVELOPMENT" in env)) return env;
  const child = { ...env };
  delete child.ZEROS_LOCAL_DEVELOPMENT;
  return child;
}
