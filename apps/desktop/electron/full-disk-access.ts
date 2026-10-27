import { constants } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";

import type { FullDiskAccessStatus } from "../shared/full-disk-access";

interface ProbeFile {
  stat(): Promise<{ isFile(): boolean }>;
  close(): Promise<void>;
}

/** macOS has no public API for querying an app's Full Disk Access toggle.
 * Check effective access to one TCC-protected file instead. Never read its
 * contents or fall back to an ordinary file (which would give false positives).
 * A successful check can also reflect the launching app's responsibility;
 * it is observation, never authority for changing agent permission policies. */
export async function probeFullDiskAccess(options: {
  platform: NodeJS.Platform;
  home: string;
  open?: (file: string, flags: number) => Promise<ProbeFile>;
}): Promise<FullDiskAccessStatus> {
  if (options.platform !== "darwin") return "unsupported";
  try {
    const file = await (options.open ?? open)(
      path.join(
        options.home,
        "Library/Application Support/com.apple.TCC/TCC.db",
      ),
      // Refuse a symlink and avoid blocking if the entry is not a regular file.
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      return (await file.stat()).isFile() ? "available" : "unknown";
    } finally {
      await file.close();
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    return code === "EPERM" || code === "EACCES" ? "denied" : "unknown";
  }
}

/** Select the running bundle, including checkout-specific development builds.
 * Guessing /Applications/Zeros.app can grant a different channel access. */
export function applicationBundlePath(executable: string): string | null {
  if (!path.isAbsolute(executable)) return null;
  const macos = path.dirname(executable);
  const contents = path.dirname(macos);
  const bundle = path.dirname(contents);
  return path.basename(macos) === "MacOS" &&
    path.basename(contents) === "Contents" &&
    bundle.endsWith(".app")
    ? bundle
    : null;
}
