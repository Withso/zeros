import { describe, expect, it, vi } from "vitest";

import { readObservedCloudWorkspacePorts } from "../cloud-observed-ports";

const HEADER =
  "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode";

describe("readObservedCloudWorkspacePorts", () => {
  it("publishes a canonical bounded set of application listeners", async () => {
    const readFile = vi
      .fn()
      .mockResolvedValueOnce(
        [
          HEADER,
          "   0: 0100007F:1455 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000 0 1",
          "   1: 00000000:9A11 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000 0 2",
          "   2: 0100007F:1455 00000000:0000 01 00000000:00000000 00:00000000 00000000  1000 0 3",
          "   3: 0100007F:0016 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000 0 4",
        ].join("\n"),
      )
      .mockResolvedValueOnce(
        [
          HEADER,
          "   0: 00000000000000000000000000000000:1F90 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000 0 5",
          "   1: 00000000000000000000000000000000:1455 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000 0 6",
        ].join("\n"),
      );

    await expect(
      readObservedCloudWorkspacePorts({
        readFile,
        excludedPorts: [39_441],
      }),
    ).resolves.toEqual([
      { port: 5_205, protocol: "tcp" },
      { port: 8_080, protocol: "tcp" },
    ]);
  });

  it("distinguishes an unavailable proc view from an authoritative empty scan", async () => {
    await expect(
      readObservedCloudWorkspacePorts({
        readFile: vi.fn().mockRejectedValue(new Error("proc unavailable")),
      }),
    ).resolves.toBeUndefined();

    await expect(
      readObservedCloudWorkspacePorts({
        readFile: vi.fn().mockResolvedValue(HEADER),
      }),
    ).resolves.toEqual([]);
  });

  it.each([
    [
      "both tables exceed the byte cap",
      [" ".repeat(4 * 1024 * 1024 + 1), " ".repeat(4 * 1024 * 1024 + 1)],
    ],
    [
      "one table exceeds the byte cap",
      [HEADER, " ".repeat(4 * 1024 * 1024 + 1)],
    ],
    ["one table cannot be read", [HEADER, new Error("proc unavailable")]],
  ] as const)(
    "retains the last observation when %s",
    async (_label, values) => {
      const readFile = vi.fn(async () => {
        const next = values[readFile.mock.calls.length - 1];
        if (next instanceof Error) throw next;
        return next;
      });

      await expect(
        readObservedCloudWorkspacePorts({ readFile }),
      ).resolves.toBeUndefined();
    },
  );
});
