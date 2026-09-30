import { describe, expect, it } from "vitest";

import { parseUpdaterStatus } from "../updater";

describe("parseUpdaterStatus", () => {
  it("restores a validated main-process requirement without retaining remote messages", () => {
    const required = { minimumVersion: "1.2.3", latestVersion: "1.2.4" };
    expect(parseUpdaterStatus({ kind: "idle", revision: 8, required: { ...required, message: "untrusted" } }))
      .toEqual({ kind: "idle", revision: 8, required });
    expect(parseUpdaterStatus({ kind: "idle", revision: 9, required: { ...required, latestVersion: "<invalid>" } }))
      .toEqual({ kind: "idle", revision: 9 });
  });
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
