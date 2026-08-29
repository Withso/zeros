/** External browser navigation shared by renderer, Electron main, and the
 * engine's legacy local OAuth opener. Parsing at every boundary prevents a
 * prefix-only check from admitting malformed/userinfo/control-character URLs. */

export const MAX_EXTERNAL_URL_LENGTH = 16 * 1024;

/** Return one canonical http(s) URL, or null when it is unsafe to hand to an OS
 * URL opener. This is a scheme/shape boundary, not an SSRF policy: the system
 * browser may intentionally open localhost and private-network pages. */
export function normalizeExternalHttpUrl(value: unknown): string | null {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_EXTERNAL_URL_LENGTH ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    !url.hostname ||
    url.username !== "" ||
    url.password !== ""
  ) {
    return null;
  }
  return url.toString();
}
