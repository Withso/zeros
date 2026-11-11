import { join } from "node:path";

/** 12.z: the folder a switch turns sync on in, without a picker:
 * ~/zeros/cloud-sync/<repository name>/<workspace number or name>. Each label
 * becomes one plain path segment (never a separator, `..`, a dot file or a
 * control character), so the folder is always under ~/zeros/cloud-sync. */
export function defaultSyncFolder(home: string, repository: string, workspace: string): string {
  return join(home, "zeros", "cloud-sync", segment(repository, "repository"), segment(workspace, "workspace"));
}

function segment(label: string, fallback: string): string {
  // eslint-disable-next-line no-control-regex -- control characters are exactly what is removed
  const clean = label.normalize("NFC").replace(/[\u0000-\u001f\u007f/\\:]/g, "-").replace(/\s+/g, " ").trim()
    .replace(/^[.\s-]+/, "").replace(/[.\s-]+$/, "").slice(0, 80);
  return clean || fallback;
}
