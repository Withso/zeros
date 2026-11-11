import { dirname, join } from "node:path";

/** 12.zz: the app's channel folder, the parent of its visible workspaces root
 * (~/zeros, ~/zeros-alpha, ~/zeros-beta, a dev instance's own), never a hard-coded ~/zeros. */
export const syncChannelFolder = (workspacesRoot: string) => dirname(workspacesRoot);

/** 12.z/12.zz: the folder a switch turns sync on in, without a picker:
 * <channel folder>/cloud-sync/<repository name>/<workspace number or name>. Each
 * label becomes one plain path segment (never a separator, `..`, a dot file or
 * a control character), so the folder is always under <channel>/cloud-sync.
 * A folder a person already syncs to is kept (callers ask the manager first). */
export function defaultSyncFolder(channel: string, repository: string, workspace: string): string {
  return join(channel, "cloud-sync", segment(repository, "repository"), segment(workspace, "workspace"));
}

function segment(label: string, fallback: string): string {
  // eslint-disable-next-line no-control-regex -- control characters are exactly what is removed
  const clean = label.normalize("NFC").replace(/[\u0000-\u001f\u007f/\\:]/g, "-").replace(/\s+/g, " ").trim()
    .replace(/^[.\s-]+/, "").replace(/[.\s-]+$/, "").slice(0, 80);
  return clean || fallback;
}
