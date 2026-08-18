import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  persistBrowserScreenshot,
  persistBrowserTrace,
} from "../browser/artifacts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

describe("Zeros browser artifacts", () => {
  it("stores private evidence under a hashed Zeros browser-session bucket", async () => {
    const root = await mkdtemp(join(tmpdir(), "zeros-browser-artifact-"));
    roots.push(root);
    const artifact = await persistBrowserScreenshot({
      root,
      browserSessionId: "browser-session-one",
      jpeg: Buffer.from("jpeg-bytes"),
      url: "https://example.com/checkout",
      title: "Checkout",
      capturedAt: 123,
    });
    expect(artifact).toMatchObject({
      kind: "browser-screenshot",
      mimeType: "image/jpeg",
      capturedAt: 123,
    });
    expect(artifact.path).not.toContain("browser-session-one");
    await expect(readFile(artifact.path)).resolves.toEqual(
      Buffer.from("jpeg-bytes"),
    );
  });

  it("bounds screenshot retention per Zeros browser session", async () => {
    const root = await mkdtemp(join(tmpdir(), "zeros-browser-artifact-"));
    roots.push(root);
    for (let index = 0; index < 4; index += 1) {
      await persistBrowserScreenshot(
        {
          root,
          browserSessionId: "browser-one",
          jpeg: Buffer.from(`jpeg-${index}`),
          url: "https://example.com",
          title: "Example",
          capturedAt: 100 + index,
        },
        { maxPerSession: 2 },
      );
    }
    const [bucket] = await readdir(root);
    await expect(readdir(join(root, bucket!))).resolves.toHaveLength(2);
  });

  it("persists a bounded trace without URL credentials", async () => {
    const root = await mkdtemp(join(tmpdir(), "zeros-browser-artifact-"));
    roots.push(root);
    const artifact = await persistBrowserTrace({
      root,
      browserSessionId: "browser-one",
      url: "https://user:secret@example.com/report?token=query-secret#fragment-secret",
      title: "Report",
      events: [{ at: 10, type: "navigation", detail: "report" }],
      capturedAt: 12,
    });
    expect(artifact.url).toBe("https://example.com/report");
    await expect(readFile(artifact.path, "utf8")).resolves.not.toContain(
      "secret",
    );
  });
});
