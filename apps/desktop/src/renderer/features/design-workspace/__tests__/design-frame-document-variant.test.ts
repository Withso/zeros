import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ frame: vi.fn() }));
vi.mock("../../../platform/git", async (original) => ({ ...(await original<typeof import("../../../platform/git")>()), designFrame: mocks.frame }));

import { designFrameDocumentKey, fetchDesignFrameDocument } from "../state/design-workspace-cache";

const version = "a".repeat(24);

describe("a main component frame's fallback document", () => {
  it("is keyed by the variant it shows and reads that variant under the source's generation", async () => {
    expect(designFrameDocumentKey("ws", "home/main.html", version, "compact")).not.toBe(designFrameDocumentKey("ws", "home/main.html", version));
    expect(designFrameDocumentKey("ws", "home/main.html", version, null)).toBe(designFrameDocumentKey("ws", "home/main.html", version));
    mocks.frame.mockResolvedValue({ file: "home/main.html", sourceVersion: version, srcDoc: "<p>compact</p>" });
    await expect(fetchDesignFrameDocument(designFrameDocumentKey("ws", "home/main.html", version, "compact"))).resolves.toMatchObject({ srcDoc: "<p>compact</p>" });
    expect(mocks.frame).toHaveBeenLastCalledWith("ws", "home/main.html", 4, "compact");
    await fetchDesignFrameDocument(designFrameDocumentKey("ws", "home/main.html", version));
    expect(mocks.frame).toHaveBeenLastCalledWith("ws", "home/main.html", 4, undefined);
  });

  it("refuses a key that names no variant's name", async () => {
    await expect(fetchDesignFrameDocument(["ws", "home/main.html", version, "Bad name"].join("\u0000"))).rejects.toThrow("Invalid");
    mocks.frame.mockResolvedValue({ file: "home/main.html", sourceVersion: "b".repeat(24), srcDoc: "" });
    await expect(fetchDesignFrameDocument(designFrameDocumentKey("ws", "home/main.html", version, "compact"))).rejects.toThrow("changed");
  });
});
