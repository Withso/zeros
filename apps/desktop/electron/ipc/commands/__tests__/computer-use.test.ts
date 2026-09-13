import { afterEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  icon: vi.fn(async () => null),
}));
vi.mock("../open-apps", () => ({ nativeAppIconByBundleId: mocks.icon }));
import { nativeAppIcons } from "../computer-use";
const event = {} as Parameters<typeof nativeAppIcons>[1];
afterEach(() => {
  vi.clearAllMocks();
});

describe("computer-use native commands", () => {
  it("accepts only bounded native bundle IDs", async () => {
    await expect(
      nativeAppIcons(
        { bundleIds: ["com.google.Chrome", "com.google.Chrome"] },
        event,
      ),
    ).resolves.toEqual({ "com.google.Chrome": null });
    expect(mocks.icon).toHaveBeenCalledTimes(1);
    for (const bundleIds of [
      ["/Applications/Chrome.app"],
      ["com.x' || true"],
      Array(17).fill("com.app"),
    ])
      await expect(nativeAppIcons({ bundleIds }, event)).rejects.toThrow(
        "Invalid",
      );
  });
});
