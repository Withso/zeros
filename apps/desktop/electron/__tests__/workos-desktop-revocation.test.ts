import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../app-base-url", () => ({
  appBaseUrl: () => "https://app-alpha.zeros.build",
}));

import { requestWorkOSDesktopRevocation } from "../workos-desktop-revocation";

afterEach(() => vi.unstubAllGlobals());

describe("WorkOS desktop revocation broker client", () => {
  it("sends only the bearer and bounded revocation scope", async () => {
    const fetchMock = vi.fn(async () => Response.json({ revoked: 1 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      requestWorkOSDesktopRevocation("current", "signed-access-token"),
    ).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://app-alpha.zeros.build/auth/desktop-revoke",
      expect.objectContaining({
        method: "POST",
        headers: {
          authorization: "Bearer signed-access-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({ scope: "current" }),
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("reports broker and network failures without throwing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 503 })),
    );
    await expect(
      requestWorkOSDesktopRevocation("all", "signed-access-token"),
    ).resolves.toBe(false);

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(new Error("offline"))),
    );
    await expect(
      requestWorkOSDesktopRevocation("all", "signed-access-token"),
    ).resolves.toBe(false);
  });
});
