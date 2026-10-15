import {
  cloudWorkspaceKey,
  isCloudWorkspace,
  parseCloudWorkspaceKey,
} from "./bridge/cloud-workspace-key";

/** Native paths are references, never workspace identities. Cloud absolute
 * paths require the owning engine's confirmed root; no basename guessing. */
export function relativeWorkspaceFilePath(
  cwd: string | null | undefined,
  rawPath: string,
  cloudRoot?: string,
): string | null {
  if (!cwd || !rawPath || rawPath.length > 4096) return null;
  // Paths from tool arguments are literal filesystem names, not URLs.
  // eslint-disable-next-line no-control-regex -- reject control bytes at the file-reference boundary
  if (/[\x00-\x1f\x7f\\]/.test(rawPath) || rawPath.startsWith("//"))
    return null;
  let path = rawPath;
  let root = cwd.replace(/\/+$/, "");
  try {
    if (isCloudWorkspace(cwd)) {
      const owner = parseCloudWorkspaceKey(cwd);
      if (!owner) return null;
      if (isCloudWorkspace(path)) {
        const target = parseCloudWorkspaceKey(path);
        if (!target || cloudWorkspaceKey(owner) !== cloudWorkspaceKey(target))
          return null;
        path = target.relativePath;
        if (owner.relativePath) {
          if (!path.startsWith(`${owner.relativePath}/`)) return null;
          path = path.slice(owner.relativePath.length + 1);
        }
      } else if (path.startsWith("/")) {
        if (!cloudRoot) return null;
        root =
          cloudRoot.replace(/\/+$/, "") +
          (owner.relativePath ? `/${owner.relativePath}` : "");
      }
    } else if (isCloudWorkspace(path)) return null;
  } catch {
    return null;
  }
  if (!isCloudWorkspace(cwd)) {
    // Match the same macOS aliases used by workspace ownership resolution.
    const canonicalLocal = (value: string) =>
      value.replace(/^\/private(\/(?:var|tmp|etc)(?:\/|$))/, "$1");
    root = canonicalLocal(root);
    path = canonicalLocal(path);
  }
  if (path.startsWith("/")) {
    if (!path.startsWith(`${root}/`)) return null;
    path = path.slice(root.length + 1);
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(path) || path.split("/").includes(".."))
    return null;
  path = path
    .split("/")
    .filter((part) => part && part !== ".")
    .join("/");
  return path || null;
}
