import { afterEach, describe, expect, it, vi } from "vitest";

import {
  runPtyCommand,
  type PtyCommandClient,
} from "../cloud-workspace-validation/lib/pty-command";

afterEach(() => {
  vi.useRealTimers();
});

describe("cloud qualification PTY commands", () => {
  it("clears its timeout when an immediate PTY write fails", async () => {
    vi.useFakeTimers();
    const writeFailure = new Error("bridge closed before PTY write");
    const client = {
      onPtyData: vi.fn(),
      ptyCreate: vi.fn().mockResolvedValue({ type: "PTY_CREATED" }),
      ptyWrite: vi.fn(() => {
        throw writeFailure;
      }),
    } as unknown as PtyCommandClient;

    await expect(
      runPtyCommand(client, "workspace-id", "git remote remove temporary"),
    ).rejects.toBe(writeFailure);

    expect(client.ptyWrite).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});
