export interface FilesTabLayout {
  hasFile: boolean;
  fileTreeVisible: boolean;
  viewerVisible: boolean;
}

/** Resolve the Files surface synchronously from the selected path and the
 * individual tab's persisted tree preference. Blank tabs deliberately ignore
 * a stale/corrupt collapsed value so they always start with a way to select
 * their first file. */
export function resolveFilesTabLayout(
  filePath: string | undefined,
  storedTreeVisible: boolean | undefined,
): FilesTabLayout {
  const hasFile = Boolean(filePath);
  const fileTreeVisible = !hasFile || storedTreeVisible === true;

  return {
    hasFile,
    fileTreeVisible,
    viewerVisible: hasFile,
  };
}
