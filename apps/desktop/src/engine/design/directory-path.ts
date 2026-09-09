/** Shared lexical guard for settings, registry entries and runtime admission.
 * Filesystem spelling, links and overlaps are checked by the Design engine. */
export function sanitizeDesignDirectoryName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const posix = raw.replace(/\\/g, "/").trim();
  if (!posix || posix.startsWith("/") || /^[A-Za-z]:/.test(posix)) return null;
  if (
    Array.from(posix).some(
      (char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
    )
  )
    return null;
  const segments = posix.split("/");
  if (
    segments.some(
      (segment) =>
        !segment ||
        segment === "." ||
        segment === ".." ||
        [".git", ".zeros"].includes(segment.normalize("NFC").toLowerCase()) ||
        /[. ]$/.test(segment),
    )
  )
    return null;
  return posix;
}

export const DESIGN_DIRECTORY_ID_PATTERN = /^design_[a-zA-Z0-9_-]{1,64}$/;

export function hasInvalidDesignSettings(warnings: readonly string[]): boolean {
  // Tracked personal files are excluded entirely: they never supply authority.
  return warnings.some(
    (warning) =>
      !warning.includes("is tracked by Git") &&
      /design\.(directory|directory_id):|design:|file is malformed/.test(
        warning,
      ),
  );
}
