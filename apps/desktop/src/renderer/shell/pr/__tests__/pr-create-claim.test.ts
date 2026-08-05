import { beforeEach, describe, expect, it } from "vitest";

import {
  claimPrCreateAction,
  isPrCreateActionClaimed,
  releasePrCreateAction,
  resetPrCreateActionClaimsForTesting,
} from "../pr-create-claim";

beforeEach(() => resetPrCreateActionClaimsForTesting());

describe("Create PR action claims", () => {
  it("survives a component remount and remains isolated by workspace", () => {
    const owner = claimPrCreateAction("workspace-a");

    expect(owner).not.toBeNull();
    expect(isPrCreateActionClaimed("workspace-a")).toBe(true);
    expect(isPrCreateActionClaimed("workspace-b")).toBe(false);
    expect(claimPrCreateAction("workspace-a")).toBeNull();
    expect(claimPrCreateAction("workspace-b")).not.toBeNull();
  });

  it("ignores a stale release so it cannot unlock a later owner", () => {
    const first = claimPrCreateAction("workspace-a");
    expect(first).not.toBeNull();
    releasePrCreateAction(first!);

    const second = claimPrCreateAction("workspace-a");
    expect(second).not.toBeNull();
    releasePrCreateAction(first!);
    expect(isPrCreateActionClaimed("workspace-a")).toBe(true);

    releasePrCreateAction(second!);
    expect(isPrCreateActionClaimed("workspace-a")).toBe(false);
  });
});
