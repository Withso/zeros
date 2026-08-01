import { describe, expect, it, vi } from "vitest";

import {
  collectBackgroundTerminals,
  collectLoadedDescendantThreadIds,
  reconcileBackgroundTerminals,
} from "../background-terminals";

describe("Codex background terminals", () => {
  it("follows opaque pagination and caps the renderer snapshot", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        data: [
          {
            itemId: "item-1",
            processId: "process-1",
            command: "pnpm test",
            cwd: "/repo",
            osPid: 1,
            cpuPercent: 10,
            rssKb: 20n,
          },
        ],
        nextCursor: "next",
      })
      .mockResolvedValueOnce({
        data: [
          {
            itemId: "item-2",
            processId: "process-2",
            command: "pnpm lint",
            cwd: "/repo",
            osPid: 2,
            cpuPercent: 5,
            rssKb: 10n,
          },
        ],
        nextCursor: null,
      });

    await expect(
      collectBackgroundTerminals(request, "thread-1"),
    ).resolves.toEqual([
      expect.objectContaining({ processId: "process-1" }),
      expect.objectContaining({ processId: "process-2" }),
    ]);
    expect(request).toHaveBeenNthCalledWith(
      2,
      "thread/backgroundTerminals/list",
      { threadId: "thread-1", cursor: "next", limit: 100 },
      { timeoutMs: 5_000 },
    );
  });

  it("counts unique process ids toward the pagination bound", async () => {
    const duplicate = {
      itemId: "item-duplicate",
      processId: "process-duplicate",
      command: "pnpm dev",
      cwd: "/repo",
      osPid: 1,
      cpuPercent: null,
      rssKb: null,
    };
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        data: Array.from({ length: 100 }, () => duplicate),
        nextCursor: "unique-page",
      })
      .mockResolvedValueOnce({
        data: [
          {
            ...duplicate,
            itemId: "item-unique",
            processId: "process-unique",
          },
        ],
        nextCursor: null,
      });

    await expect(
      collectBackgroundTerminals(request, "thread-1"),
    ).resolves.toEqual([
      expect.objectContaining({ processId: "process-duplicate" }),
      expect.objectContaining({ processId: "process-unique" }),
    ]);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("preserves start time, returns removals, and omits CPU/memory chrome", () => {
    const first = reconcileBackgroundTerminals(
      new Map(),
      [
        {
          itemId: "item-1",
          processId: "process-1",
          command: "pnpm test",
          cwd: "/repo",
          osPid: 1,
          cpuPercent: 99,
          rssKb: 4_096n,
        },
      ],
      100,
    );
    const second = reconcileBackgroundTerminals(first.active, [], 5_000);

    expect(first.active.get("process-1")).toEqual({
      taskId: "process-1",
      name: "pnpm test",
      taskType: "codex_terminal",
      startedAt: 100,
      updatedAt: 100,
      command: "pnpm test",
    });
    expect(second.removed).toEqual([
      expect.objectContaining({ taskId: "process-1", startedAt: 100 }),
    ]);
  });

  it("discovers loaded descendants across pages for resumed collaboration trees", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        data: [
          { id: "child-active", status: { type: "active", activeFlags: [] } },
          { id: "child-unloaded", status: { type: "notLoaded" } },
        ],
        nextCursor: "next-descendants",
      })
      .mockResolvedValueOnce({
        data: [{ id: "grandchild-idle", status: { type: "idle" } }],
        nextCursor: null,
      });

    await expect(
      collectLoadedDescendantThreadIds(request, "thread-parent"),
    ).resolves.toEqual(["child-active", "grandchild-idle"]);
    expect(request).toHaveBeenNthCalledWith(
      1,
      "thread/list",
      expect.objectContaining({
        ancestorThreadId: "thread-parent",
        cursor: null,
        limit: 100,
        sourceKinds: expect.arrayContaining([
          "subAgent",
          "subAgentThreadSpawn",
          "subAgentOther",
        ]),
      }),
      { timeoutMs: 5_000 },
    );
    expect(request).toHaveBeenNthCalledWith(
      2,
      "thread/list",
      expect.objectContaining({ cursor: "next-descendants" }),
      { timeoutMs: 5_000 },
    );
  });
});
