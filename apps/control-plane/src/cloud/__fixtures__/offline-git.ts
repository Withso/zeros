// Tests that run real Git and shells never reach GitHub, whatever the machine they run on.

/** Git configuration for a test's environment: any https://github.com/ URL a test has not mapped to a fixture origin
 * resolves to a path no protocol rule allows, so it fails without a network. A test that maps one sets its own
 * GIT_CONFIG_COUNT, or a longer insteadOf (the longest match wins). */
export const OFFLINE_GIT_ENV = {
  GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "url./nonexistent/no-network/.insteadOf", GIT_CONFIG_VALUE_0: "https://github.com/",
} as const;

/** The first line of a test's shell script: some machines' shells, started from Node, put /bin first on PATH, which
 * would bypass a test's stub Git, sudo or rm for the real one. */
export const pinnedPath = (path: string | undefined): string[] => path ? [`export PATH='${path.replaceAll("'", "'\\''")}'`] : [];
