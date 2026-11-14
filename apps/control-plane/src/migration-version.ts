export const MINIMUM_POSTGRES_VERSION = 160000;

export function migrationServerVersion(value: unknown): number | null {
  const number = typeof value === "number" ? value
    : typeof value === "string" && /^[1-9][0-9]*$/.test(value) ? Number(value) : NaN;
  return Number.isSafeInteger(number) && number > 0 && number <= 2147483647 ? number : null;
}

export function migrationVersionDiagnostic(version: number | null): string {
  return `[migrate] server_version_num=${version ?? "unknown"} minimum=${MINIMUM_POSTGRES_VERSION} ${
    version !== null && version >= MINIMUM_POSTGRES_VERSION ? "accepted" : "refused"}`;
}
