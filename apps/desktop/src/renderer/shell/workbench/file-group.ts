import { relativeWorkspaceFilePath } from "@/renderer/platform/workspace-file-path";

export interface FileGroup {
  id: string;
  name: string;
  files: Array<{ name: string; path: string; attachmentId?: string }>;
}

/** Persist only bounded, literal relative paths. No blobs, generated manifest
 * or virtual file format is involved in a group. */
export function normalizeFileGroup(value: unknown): FileGroup | undefined {
  if (!value || typeof value !== "object") return;
  const group = value as Partial<FileGroup>;
  if (
    typeof group.id !== "string" ||
    !group.id ||
    group.id.length > 160 ||
    typeof group.name !== "string" ||
    !group.name ||
    group.name.length > 512 ||
    !Array.isArray(group.files) ||
    !group.files.length ||
    group.files.length > 1000
  )
    return;
  const files: FileGroup["files"] = [];
  for (const file of group.files) {
    if (
      !file ||
      typeof file.name !== "string" ||
      !file.name ||
      file.name.length > 512 ||
      typeof file.path !== "string" ||
      file.path.length > 8192 ||
      relativeWorkspaceFilePath("/group-root", file.path) !== file.path
    )
      return;
    files.push({
      name: file.name,
      path: file.path,
      ...(typeof file.attachmentId === "string" &&
      file.attachmentId.length <= 160
        ? { attachmentId: file.attachmentId }
        : {}),
    });
  }
  return { id: group.id, name: group.name, files };
}
