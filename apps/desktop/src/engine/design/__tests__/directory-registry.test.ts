import { describe, expect, it } from "vitest";

import {
  designDirectoryNameFor,
  forgetDesignDirectoryName,
  primeDesignDirectoryName,
  withDesignDirectoryNameLease,
} from "../directory-registry";

describe("Design directory registry", () => {
  it("keeps concurrent read leases context-local without changing mutation authority", async () => {
    const workspace = "/tmp/zeros-directory-registry-context";
    primeDesignDirectoryName(workspace, "Canonical Design");
    let releaseFirst!: () => void;
    const firstHeld = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstReady!: () => void;
    const ready = new Promise<void>((resolve) => {
      firstReady = resolve;
    });

    const first = withDesignDirectoryNameLease(
      workspace,
      "Projection A",
      async () => {
        expect(designDirectoryNameFor(workspace)).toBe("Projection A");
        firstReady();
        await firstHeld;
        expect(designDirectoryNameFor(workspace)).toBe("Projection A");
      },
    );
    await ready;

    await expect(
      withDesignDirectoryNameLease(workspace, "Projection B", async () =>
        designDirectoryNameFor(workspace),
      ),
    ).resolves.toBe("Projection B");
    expect(designDirectoryNameFor(workspace)).toBe("Canonical Design");

    releaseFirst();
    await first;
    expect(designDirectoryNameFor(workspace)).toBe("Canonical Design");
    forgetDesignDirectoryName(workspace);
  });
});
