import { afterEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  icon: vi.fn(async () => null),
  name: vi.fn(async (bundleId: string) =>
    bundleId === "com.apple.Safari" ? "Safari" : null,
  ),
  identity: vi.fn(
    async (_appPath: string): Promise<{ bundleId: string; name: string } | null> => ({
      bundleId: "com.apple.Safari",
      name: "Safari",
    }),
  ),
}));
vi.mock("../open-apps", () => ({
  nativeAppIconByBundleId: mocks.icon,
  nativeAppNameByBundleId: mocks.name,
  appBundleIdentity: mocks.identity,
}));
import { chooseComputerApp, nativeAppIcons, nativeAppNames } from "../computer-use";
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
    ]) {
      await expect(nativeAppIcons({ bundleIds }, event)).rejects.toThrow(
        "Invalid",
      );
      await expect(nativeAppNames({ bundleIds }, event)).rejects.toThrow(
        "Invalid",
      );
    }
  });

  it("names installed apps and leaves unknown ones null", async () => {
    await expect(
      nativeAppNames(
        { bundleIds: ["com.apple.Safari", "com.example.Missing"] },
        event,
      ),
    ).resolves.toEqual({
      "com.apple.Safari": "Safari",
      "com.example.Missing": null,
    });
  });

  it("returns only the chosen app's bundle ID and name", async () => {
    const showOpenDialog = vi.fn(async () => ({
      canceled: false,
      filePaths: ["/Applications/Safari.app"],
    }));
    await expect(chooseComputerApp(showOpenDialog)).resolves.toEqual({
      bundleId: "com.apple.Safari",
      name: "Safari",
    });
    expect(showOpenDialog).toHaveBeenCalledWith(
      expect.objectContaining({
        properties: ["openFile"],
        filters: [{ name: "Applications", extensions: ["app"] }],
      }),
    );
    expect(mocks.identity).toHaveBeenCalledWith("/Applications/Safari.app");
  });

  it("treats a cancelled panel as no choice and rejects apps without an ID", async () => {
    await expect(
      chooseComputerApp(async () => ({ canceled: true, filePaths: [] })),
    ).resolves.toBeNull();
    expect(mocks.identity).not.toHaveBeenCalled();

    mocks.identity.mockResolvedValueOnce(null);
    await expect(
      chooseComputerApp(async () => ({
        canceled: false,
        filePaths: ["/Applications/Broken.app"],
      })),
    ).rejects.toThrow("no bundle identifier");

    mocks.identity.mockResolvedValueOnce({ bundleId: "not an id", name: "Odd" });
    await expect(
      chooseComputerApp(async () => ({
        canceled: false,
        filePaths: ["/Applications/Odd.app"],
      })),
    ).rejects.toThrow("no bundle identifier");
  });
});
