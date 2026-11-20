/** Settings → Local Storage contract between Electron main and the renderer.
 * The renderer names categories from this closed set; main alone maps them to
 * locations on disk. */
export const LOCAL_STORAGE_CATEGORY_IDS = [
  "workspaces",
  "cloud-sync",
  "chats",
  "provider-accounts",
  "window-state",
  "other-app-data",
  "cache",
  "logs",
  "updates",
] as const;

export type LocalStorageCategoryId = (typeof LOCAL_STORAGE_CATEGORY_IDS)[number];

export const LOCAL_STORAGE_REVEALABLE: ReadonlySet<LocalStorageCategoryId> = new Set([
  "workspaces",
  "cloud-sync",
  "chats",
  "provider-accounts",
  "window-state",
  "other-app-data",
  "logs",
]);

export const LOCAL_STORAGE_CLEARABLE: ReadonlySet<LocalStorageCategoryId> = new Set(["cache"]);

export const LOCAL_STORAGE_PROGRESS_EVENT = "local-storage-progress";

/** `measured` is exact; `partial` is a lower bound (a timeout or unreadable
 * folder interrupted it); `unmeasured` has no number and must never render as
 * zero. `bytes` is the last confirmed value; it stays while `measuring`. */
export type LocalStorageStatus = "unmeasured" | "measured" | "partial";

export interface LocalStorageCategory {
  id: LocalStorageCategoryId;
  status: LocalStorageStatus;
  bytes: number | null;
  measuring: boolean;
  /** Lower bound reached so far by the measurement in progress. */
  progressBytes: number | null;
  /** Home-relative display path, sent only for rows that show one. */
  location: string | null;
  revealable: boolean;
}

export interface LocalStorageReport {
  /** Main's monotonic revision; the renderer ignores anything older. */
  revision: number;
  measuring: boolean;
  /** When the last uninterrupted measurement finished. */
  measuredAt: number | null;
  categories: LocalStorageCategory[];
}

export interface LocalStorageClearResult {
  /** Measured cache size before minus after; null when either was unmeasured. */
  freedBytes: number | null;
  report: LocalStorageReport;
}

const STATUSES = new Set<LocalStorageStatus>(["unmeasured", "measured", "partial"]);

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function isLocalStorageCategoryId(value: unknown): value is LocalStorageCategoryId {
  return typeof value === "string" && (LOCAL_STORAGE_CATEGORY_IDS as readonly string[]).includes(value);
}

export function parseLocalStorageReport(value: unknown): LocalStorageReport {
  const report = value as Partial<LocalStorageReport> | null;
  if (
    !report ||
    typeof report !== "object" ||
    !isCount(report.revision) ||
    typeof report.measuring !== "boolean" ||
    !(report.measuredAt === null || isCount(report.measuredAt)) ||
    !Array.isArray(report.categories) ||
    report.categories.length !== LOCAL_STORAGE_CATEGORY_IDS.length
  )
    throw new Error("Could not read Local Storage.");
  const categories = report.categories.map((raw, index): LocalStorageCategory => {
    const item = raw as Partial<LocalStorageCategory> | null;
    if (
      !item ||
      item.id !== LOCAL_STORAGE_CATEGORY_IDS[index] ||
      !STATUSES.has(item.status as LocalStorageStatus) ||
      !(item.bytes === null || isCount(item.bytes)) ||
      (item.status === "unmeasured") !== (item.bytes === null) ||
      typeof item.measuring !== "boolean" ||
      !(item.progressBytes === null || isCount(item.progressBytes)) ||
      !(item.location === null || typeof item.location === "string") ||
      typeof item.revealable !== "boolean"
    )
      throw new Error("Could not read Local Storage.");
    return {
      id: item.id,
      status: item.status!,
      bytes: item.bytes,
      measuring: item.measuring,
      progressBytes: item.progressBytes,
      location: item.location,
      revealable: item.revealable,
    };
  });
  return {
    revision: report.revision,
    measuring: report.measuring,
    measuredAt: report.measuredAt,
    categories,
  };
}

export function parseLocalStorageClearResult(value: unknown): LocalStorageClearResult {
  const result = value as Partial<LocalStorageClearResult> | null;
  if (!result || typeof result !== "object" || !(result.freedBytes === null || isCount(result.freedBytes)))
    throw new Error("Could not read Local Storage.");
  return { freedBytes: result.freedBytes, report: parseLocalStorageReport(result.report) };
}
