import { describe, expect, it } from "vitest";
import {
  LOCAL_STORAGE_CATEGORY_IDS,
  type LocalStorageCategory,
  type LocalStorageReport,
} from "../../../../../shared/local-storage";
import { formatBytes, sizeDisplay, summarize, updatedLabel } from "../local-storage-format";

const category = (patch: Partial<LocalStorageCategory>): LocalStorageCategory => ({
  id: "workspaces",
  status: "unmeasured",
  bytes: null,
  measuring: false,
  progressBytes: null,
  location: null,
  revealable: false,
  ...patch,
});
const report = (patch: (id: string) => Partial<LocalStorageCategory>, measuring = false): LocalStorageReport => ({
  revision: 1,
  measuring,
  measuredAt: 1_000,
  categories: LOCAL_STORAGE_CATEGORY_IDS.map((id) => category({ id, ...patch(id) })),
});

describe("Local Storage presentation", () => {
  it.each([
    [0, "0 KB"],
    [1024, "1 KB"],
    [999_499, "999 KB"],
    [999_500, "1.0 MB"],
    [2_400_000, "2.4 MB"],
    [58_000_000, "58 MB"],
    [999_600_000, "1.0 GB"],
    [1_020_000_000, "1.0 GB"],
    [12_300_000_000, "12 GB"],
    [3_200_000_000_000, "3.2 TB"],
  ])("formats %d bytes as %s", (bytes, text) => {
    expect(formatBytes(bytes)).toBe(text);
  });

  it("never shows a failed or unknown size as a number", () => {
    expect(sizeDisplay(undefined)).toEqual({ kind: "pending" });
    expect(sizeDisplay(category({ measuring: true }))).toEqual({ kind: "pending" });
    expect(sizeDisplay(category({ measuring: true, progressBytes: 41 }))).toEqual({ kind: "at-least", bytes: 41 });
    expect(sizeDisplay(category({}))).toEqual({ kind: "unmeasured" });
    expect(sizeDisplay(category({ status: "partial", bytes: 9 }))).toEqual({ kind: "at-least", bytes: 9 });
    // A confirmed size stays while it is measured again.
    expect(sizeDisplay(category({ status: "measured", bytes: 7, measuring: true, progressBytes: 2 }))).toEqual({ kind: "exact", bytes: 7 });
  });

  it("marks the total as a lower bound unless every row is exact", () => {
    const exact = summarize(report(() => ({ status: "measured", bytes: 10 })));
    expect(exact).toMatchObject({ total: 90, exact: true, known: true });
    expect(exact.groups.map((g) => [g.id, g.bytes])).toEqual([
      ["work", 20], ["providers", 10], ["app", 30], ["updates", 10], ["temporary", 20],
    ]);
    const partial = summarize(report((id) => (id === "logs" ? {} : { status: "measured", bytes: 10 })));
    expect(partial).toMatchObject({ total: 80, exact: false });
    expect(summarize(null)).toMatchObject({ total: 0, exact: false, known: false });
  });

  it("describes freshness", () => {
    expect(updatedLabel(null, 0)).toBe("Not measured yet");
    expect(updatedLabel(report(() => ({}), true), 0)).toBe("Measuring…");
    expect(updatedLabel(report(() => ({})), 30_000)).toBe("Updated just now");
    expect(updatedLabel(report(() => ({})), 1_000 + 3 * 60_000)).toBe("Updated 3 minutes ago");
    expect(updatedLabel(report(() => ({})), 1_000 + 60 * 60_000)).toBe("Updated 1 hour ago");
  });
});
