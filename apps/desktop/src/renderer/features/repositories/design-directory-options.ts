export interface DesignDirectoryListing {
  directories: string[];
  pointer: string;
  active: string;
  /** What Design entry would use in the main checkout — adopts a single
   * committed folder, or names the first-use folder ("<repo> - Design"). */
  target?: { directory: string; exists: boolean } | null;
}

export interface DesignDirectoryOption {
  name: string;
  active: boolean;
  exists: boolean;
  selectable: boolean;
}

/** Derive the folder rows without mistaking an inferred entry target for a
 * persisted pointer. Target metadata also knows about untracked marker-backed
 * directories that intentionally do not appear in the tracked listing. */
export function deriveDesignDirectoryOptions(input: {
  pointer: string | null;
  listing: DesignDirectoryListing | null;
}): { activeName: string; options: DesignDirectoryOption[] } {
  const activeName =
    input.pointer ??
    input.listing?.target?.directory ??
    input.listing?.pointer ??
    "Zeros Design";
  const explicitActive = input.pointer !== null;
  const names = input.listing
    ? [...new Set([activeName, ...input.listing.directories])].sort((a, b) =>
        a.localeCompare(b),
      )
    : [activeName];
  return {
    activeName,
    options: names.map((name) => {
      const active = explicitActive && name === activeName;
      const targetExists =
        input.listing?.target?.directory === name &&
        input.listing.target.exists;
      return {
        name,
        active,
        exists:
          (input.listing?.directories.includes(name) ?? false) || targetExists,
        selectable: !active,
      };
    }),
  };
}
