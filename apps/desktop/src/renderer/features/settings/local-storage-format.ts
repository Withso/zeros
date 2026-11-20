import type {
  LocalStorageCategory,
  LocalStorageCategoryId,
  LocalStorageReport,
} from "../../../../shared/local-storage";

const UNITS = ["KB", "MB", "GB", "TB"] as const;

/** Decimal units, as Finder reports sizes. */
export function formatBytes(bytes: number): string {
  let value = bytes / 1000;
  let unit = 0;
  while (value >= 999.5 && unit < UNITS.length - 1) {
    value /= 1000;
    unit += 1;
  }
  const text = unit > 0 && value < 9.95 ? value.toFixed(1) : String(Math.round(value));
  return `${text} ${UNITS[unit]}`;
}

export type SizeDisplay =
  | { kind: "exact"; bytes: number }
  | { kind: "at-least"; bytes: number }
  | { kind: "pending" }
  | { kind: "unmeasured" };

/** A known size stays while it is measured again; an unknown one shows the
 * walk's lower bound or a placeholder; a failure never reads as zero. */
export function sizeDisplay(category: LocalStorageCategory | undefined): SizeDisplay {
  if (!category) return { kind: "pending" };
  if (category.status === "measured") return { kind: "exact", bytes: category.bytes! };
  if (category.status === "partial") return { kind: "at-least", bytes: category.bytes! };
  if (category.measuring)
    return category.progressBytes ? { kind: "at-least", bytes: category.progressBytes } : { kind: "pending" };
  return { kind: "unmeasured" };
}

export type SummaryGroup = "work" | "providers" | "app" | "updates" | "temporary";

export const SUMMARY_GROUPS: { id: SummaryGroup; label: string; categories: LocalStorageCategoryId[] }[] = [
  { id: "work", label: "Your work", categories: ["workspaces", "cloud-sync"] },
  { id: "providers", label: "Provider accounts", categories: ["provider-accounts"] },
  { id: "app", label: "App data", categories: ["chats", "window-state", "other-app-data"] },
  { id: "updates", label: "Updates", categories: ["updates"] },
  { id: "temporary", label: "Cache and logs", categories: ["cache", "logs"] },
];

export interface StorageSummary {
  /** Sum of every size shown; a lower bound unless `exact`. */
  total: number;
  exact: boolean;
  known: boolean;
  groups: { id: SummaryGroup; label: string; bytes: number }[];
}

export function summarize(report: LocalStorageReport | null): StorageSummary {
  const byId = new Map(report?.categories.map((category) => [category.id, category]));
  let total = 0;
  let exact = report !== null;
  let known = false;
  const groups = SUMMARY_GROUPS.map((group) => {
    let bytes = 0;
    for (const id of group.categories) {
      const size = sizeDisplay(byId.get(id));
      if (size.kind === "exact" || size.kind === "at-least") {
        bytes += size.bytes;
        known = true;
      }
      if (size.kind !== "exact") exact = false;
    }
    total += bytes;
    return { id: group.id, label: group.label, bytes };
  });
  return { total, exact, known, groups };
}

export function updatedLabel(report: LocalStorageReport | null, now: number): string {
  if (report?.measuring) return "Measuring…";
  if (!report?.measuredAt) return "Not measured yet";
  const minutes = Math.floor((now - report.measuredAt) / 60_000);
  if (minutes < 1) return "Updated just now";
  if (minutes < 60) return `Updated ${minutes} ${minutes === 1 ? "minute" : "minutes"} ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `Updated ${hours} ${hours === 1 ? "hour" : "hours"} ago` : "Updated over a day ago";
}
