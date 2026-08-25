import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveWorkOSDesktopAccountId } from "../workos-desktop-account";

const originalControlPlaneUrl = process.env.ZEROS_CONTROL_PLANE_URL;

afterEach(() => {
  if (originalControlPlaneUrl === undefined) {
    delete process.env.ZEROS_CONTROL_PLANE_URL;
  } else {
    process.env.ZEROS_CONTROL_PLANE_URL = originalControlPlaneUrl;
  }
  vi.unstubAllGlobals();
});

describe("WorkOS desktop account resolution", () => {
  it("resolves the canonical internal account UUID through authenticated /v1/me", async () => {
    process.env.ZEROS_CONTROL_PLANE_URL = "https://api-alpha.zeros.build";
    const fetchMock = vi.fn(async () =>
      Response.json({
        user: { id: "00000000-0000-4000-8000-000000000001" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      resolveWorkOSDesktopAccountId("signed-access-token"),
    ).resolves.toBe("00000000-0000-4000-8000-000000000001");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api-alpha.zeros.build/v1/me",
      expect.objectContaining({
        headers: expect.objectContaining({
          authorization: "Bearer signed-access-token",
        }),
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("rejects a missing or non-UUID product owner", async () => {
    process.env.ZEROS_CONTROL_PLANE_URL = "https://api-alpha.zeros.build";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ user: { id: "user_example" } })),
    );

    await expect(
      resolveWorkOSDesktopAccountId("signed-access-token"),
    ).rejects.toThrow(/identifier/i);
  });
});
