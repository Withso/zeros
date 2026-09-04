import path from "node:path";

function normalizedRepoPath(candidate: string): string | null {
  const slash = candidate.replace(/\\/g, "/");
  if (!slash || slash.startsWith("/") || /^[A-Za-z]:\//.test(slash)) {
    return null;
  }
  const normalized = path.posix.normalize(slash).replace(/\/+$/, "");
  if (
    !normalized ||
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../")
  ) {
    return null;
  }
  return normalized.replace(/^\.\//, "");
}

/** Git reports repository paths using the spelling recorded in its index,
 * while APFS/HFS+ and Windows commonly resolve case/Unicode aliases to the
 * same vnode. Authority checks must follow the host's path identity rather
 * than a byte-exact string comparison. */
export function repoPathOverlapsDesignRoot(
  candidate: string,
  designRoot: string,
  options: {
    caseInsensitive?: boolean;
  } = {},
): boolean {
  let normalized = normalizedRepoPath(candidate);
  let normalizedRoot = normalizedRepoPath(designRoot);
  if (!normalized || !normalizedRoot) return false;
  const caseInsensitive =
    options.caseInsensitive ??
    (process.platform === "darwin" || process.platform === "win32");
  if (caseInsensitive) {
    normalized = normalized.normalize("NFC").toLocaleLowerCase("en-US");
    normalizedRoot = normalizedRoot
      .normalize("NFC")
      .toLocaleLowerCase("en-US");
  }
  return (
    normalized === normalizedRoot ||
    normalized.startsWith(`${normalizedRoot}/`) ||
    normalizedRoot.startsWith(`${normalized}/`)
  );
}
