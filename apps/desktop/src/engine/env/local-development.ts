/** Local admission and the launcher's layout selection belong to the
 * desktop/engine, never a user subprocess. */
const LOCAL_DEVELOPMENT_ENV = ["ZEROS_LOCAL_DEVELOPMENT", "ZEROS_LOCAL_LAYOUT"] as const;

export function hasLocalDevelopmentEnvironment(
  env: Record<string, string | undefined>,
): boolean {
  return LOCAL_DEVELOPMENT_ENV.some((name) => name in env);
}

export function withoutLocalDevelopment<
  T extends Record<string, string | undefined>,
>(env: T): T {
  if (!hasLocalDevelopmentEnvironment(env)) return env;
  const child = { ...env };
  for (const name of LOCAL_DEVELOPMENT_ENV) delete child[name];
  return child;
}
