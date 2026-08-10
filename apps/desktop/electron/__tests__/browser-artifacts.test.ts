import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  persistBrowserScreenshot,
  persistBrowserTrace,
} from "../browser-artifacts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

describe("browser artifacts", () => {
  it("writes a task-scoped screenshot with bounded metadata", async () => {
    const root = await mkdtemp(join(tmpdir(), "zeros-browser-artifact-"));
    roots.push(root);

    const artifact = await persistBrowserScreenshot({
      root,
      taskId: "task-one",
      jpeg: Buffer.from("jpeg-bytes"),
      url: "https://example.com/checkout",
      title: "Checkout",
      capturedAt: 123,
    });

    expect(artifact).toMatchObject({
      kind: "browser-screenshot",
      mimeType: "image/jpeg",
      url: "https://example.com/checkout",
      title: "Checkout",
      capturedAt: 123,
    });
    expect(artifact.path).toMatch(/\.jpe?g$/);
    await expect(readFile(artifact.path)).resolves.toEqual(
      Buffer.from("jpeg-bytes"),
    );
  });

  it("prunes old screenshots within the same task bucket", async () => {
    const root = await mkdtemp(join(tmpdir(), "zeros-browser-artifact-"));
    roots.push(root);

    for (let index = 0; index < 4; index += 1) {
      await persistBrowserScreenshot(
        {
          root,
          taskId: "task-one",
          jpeg: Buffer.from(`jpeg-${index}`),
          url: "https://example.com",
          title: "Example",
          capturedAt: 100 + index,
        },
        { maxPerTask: 2 },
      );
    }

    const taskDirectories = await readdir(root);
    expect(taskDirectories).toHaveLength(1);
    await expect(
      readdir(join(root, taskDirectories[0]!)),
    ).resolves.toHaveLength(2);
  });

  it("rejects unsafe or oversized artifact inputs", async () => {
    const root = await mkdtemp(join(tmpdir(), "zeros-browser-artifact-"));
    roots.push(root);

    await expect(
      persistBrowserScreenshot({
        root,
        taskId: "bad/task",
        jpeg: Buffer.from("jpeg"),
        url: "https://example.com",
        title: "Example",
        capturedAt: 1,
      }),
    ).rejects.toThrow(/task/i);
    await expect(
      persistBrowserScreenshot(
        {
          root,
          taskId: "task-one",
          jpeg: Buffer.alloc(11),
          url: "https://example.com",
          title: "Example",
          capturedAt: 1,
        },
        { maxBytes: 10 },
      ),
    ).rejects.toThrow(/size/i);
  });

  it("writes a bounded task-scoped browser trace as private JSON evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "zeros-browser-artifact-"));
    roots.push(root);

    const artifact = await persistBrowserTrace({
      root,
      taskId: "task-one",
      url: "https://example.com/report",
      title: "Report",
      events: [
        { at: 10, type: "navigation", detail: "https://example.com/report" },
        { at: 11, type: "console", detail: "warning: example" },
      ],
      capturedAt: 12,
    });

    expect(artifact).toMatchObject({
      kind: "browser-trace",
      mimeType: "application/json",
      eventCount: 2,
      capturedAt: 12,
    });
    await expect(readFile(artifact.path, "utf8")).resolves.toContain(
      '"navigation"',
    );
  });
});
