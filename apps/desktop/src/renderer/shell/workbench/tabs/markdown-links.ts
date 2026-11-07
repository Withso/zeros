/** The file a link in the previewed Markdown file `fromPath` names, resolved
 *  as GitHub resolves repository links: from that file's folder, or from the
 *  workspace root after a leading `/`. Returns a path on the same root as
 *  `fromPath`, or null for a URL, an in-page anchor, a folder or anything
 *  that would leave the workspace; those stay ordinary links. */
export function markdownLinkTarget(href: string, fromPath: string): string | null {
  const raw = href.trim();
  if (!raw || raw.length > 4096 || raw.startsWith("#") || raw.startsWith("//")) return null;
  // Any scheme (https:, mailto:, file:, zeros-local:) or a drive letter.
  if (/^[a-z][a-z\d+.-]*:/i.test(raw)) return null;
  let path = raw.replace(/[?#][\s\S]*$/, "");
  try {
    path = decodeURIComponent(path);
  } catch {
    return null;
  }
  // eslint-disable-next-line no-control-regex -- control bytes never name a workspace file
  if (!path || /[\x00-\x1f\x7f\\]/.test(path)) return null;
  const segments = path.split("/");
  const name = segments[segments.length - 1];
  if (!name || name === "." || name === "..") return null;
  const parts: string[] = [];
  const base = path.startsWith("/") ? [] : fromPath.split("/").slice(0, -1);
  for (const segment of [...base, ...segments]) {
    if (!segment || segment === ".") continue;
    if (segment !== "..") parts.push(segment);
    else if (parts.pop() === undefined) return null;
  }
  return parts.join("/");
}
