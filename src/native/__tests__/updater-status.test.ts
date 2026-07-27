import { describe, expect, it } from "vitest";

import { parseUpdaterStatus } from "../updater";

describe("parseUpdaterStatus", () => {
  it("accepts a staged-ready snapshot with its monotonic revision", () => {
    expect(
      parseUpdaterStatus({ kind: "ready", version: "1.2.3", revision: 7 }),
    ).toEqual({ kind: "ready", version: "1.2.3", revision: 7 });
  });

  it("rejects missing/non-monotonic revisions and malformed progress", () => {
    expect(parseUpdaterStatus({ kind: "ready", version: "1.2.3" })).toBeNull();
    expect(
      parseUpdaterStatus({ kind: "idle", revision: Number.NaN }),
    ).toBeNull();
    expect(
      parseUpdaterStatus({
        kind: "downloading",
        version: "1.2.3",
        downloaded: "lots",
        revision: 2,
      }),
    ).toBeNull();
  });

  it("sanitizes optional download fields", () => {
    expect(
      parseUpdaterStatus({
        kind: "downloading",
        version: "1.2.3",
        downloaded: 10,
        total: "unknown",
        revision: 3,
      }),
    ).toEqual({
      kind: "downloading",
      version: "1.2.3",
      downloaded: 10,
      revision: 3,
    });
  });
});
