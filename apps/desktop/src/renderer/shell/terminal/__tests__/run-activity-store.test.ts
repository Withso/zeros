import { describe, expect, it } from "vitest";

import {
  getRunActivitySnapshot,
  invalidateRunActivitySnapshot,
  publishRunActivity,
  refreshRunActivitySnapshot,
} from "../run-activity-store";

describe("run activity store", () => {
  it("keeps the live signal scoped to its exact folder", () => {
    const first = "/tmp/zeros-run-activity-first";
    const second = "/tmp/zeros-run-activity-second";

    publishRunActivity(first, true);

    expect(getRunActivitySnapshot(first)).toBe(true);
    expect(getRunActivitySnapshot(second)).toBe(false);

    publishRunActivity(first, false);

    expect(getRunActivitySnapshot(first)).toBe(false);
  });

  it("keeps concurrent refreshes isolated by exact workspace folder", async () => {
    const first = "/tmp/zeros-run-activity-refresh-first";
    const second = "/tmp/zeros-run-activity-refresh-second";

    await Promise.all([
      refreshRunActivitySnapshot(first, async () => true),
      refreshRunActivitySnapshot(second, async () => false),
    ]);

    expect(getRunActivitySnapshot(first)).toBe(true);
    expect(getRunActivitySnapshot(second)).toBe(false);

    publishRunActivity(first, false);
  });

  it("rejects an older run-state result after invalidation", async () => {
    const folder = "/tmp/zeros-run-activity-race";
    let resolveOlder!: (running: boolean) => void;
    let resolveNewer!: (running: boolean) => void;
    const olderResult = new Promise<boolean>((resolve) => {
      resolveOlder = resolve;
    });
    const newerResult = new Promise<boolean>((resolve) => {
      resolveNewer = resolve;
    });

    const older = refreshRunActivitySnapshot(folder, () => olderResult);
    invalidateRunActivitySnapshot(folder);
    const newer = refreshRunActivitySnapshot(folder, () => newerResult);

    resolveOlder(true);
    resolveNewer(false);
    await Promise.all([older, newer]);

    expect(getRunActivitySnapshot(folder)).toBe(false);
  });

  it("lets an authoritative same-value live signal supersede an older read", async () => {
    const folder = "/tmp/zeros-run-activity-live-race";
    let resolveOlder!: (running: boolean) => void;
    const olderResult = new Promise<boolean>((resolve) => {
      resolveOlder = resolve;
    });

    publishRunActivity(folder, true);
    invalidateRunActivitySnapshot(folder);
    const older = refreshRunActivitySnapshot(folder, () => olderResult);

    publishRunActivity(folder, true);
    resolveOlder(false);
    await older;

    expect(getRunActivitySnapshot(folder)).toBe(true);
    publishRunActivity(folder, false);
  });
});
