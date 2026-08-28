// Types for schemes.mjs. Declarations only — the allow-list itself lives in
// schemes.mjs so the .mjs tests and the .ts consumers share ONE runtime value.
export declare const SCHEMES: ReadonlySet<string>;
export declare const DEFAULT_SCHEME: string;
export declare function schemeOrDefault(scheme: string): string;
export declare function schemeForDeploymentEnvironment(
  environment: "alpha" | "beta" | "production" | undefined,
  requestedScheme: string,
): string;
