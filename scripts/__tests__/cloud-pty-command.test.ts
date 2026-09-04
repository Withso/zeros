import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const randomUUID = vi.hoisted(() => vi.fn());

vi.mock("node:crypto", () => ({ randomUUID }));

import {
  runPtyCommand,
  type PtyCommandClient,
} from "../cloud-workspace-validation/lib/pty-command";

afterEach(() => {
  vi.useRealTimers();
});

beforeEach(() => {
  randomUUID
    .mockReset()
    .mockReturnValueOnce("11111111-1111-4111-8111-111111111111")
    .mockReturnValueOnce("22222222-2222-4222-8222-222222222222")
    .mockReturnValueOnce("33333333-3333-4333-8333-333333333333");
});

describe("cloud qualification PTY commands", () => {
  it("does not accept the terminal's echoed input as a success marker", async () => {
    vi.useFakeTimers();
    let onData: ((sessionId: string, data: string) => void) | undefined;
    const client = {
      onPtyData: vi.fn(
        (listener: (sessionId: string, data: string) => void) => {
          onData = listener;
        },
      ),
      ptyCreate: vi.fn().mockResolvedValue({ type: "PTY_CREATED" }),
      ptyWrite: vi.fn((sessionId: string, data: string) => {
        onData?.(sessionId, data);
      }),
    } as unknown as PtyCommandClient;

    const completion = runPtyCommand(
      client,
      "workspace-id",
      "git remote add temporary git@example.test:repo.git",
    );
    await vi.waitFor(() => expect(client.ptyWrite).toHaveBeenCalledOnce());

    const [sessionId, input] = vi.mocked(client.ptyWrite).mock.calls[0]!;
    const success = "ZEROS_COMMAND_OK_22222222222242228222222222222222";
    const failed = "ZEROS_COMMAND_FAILED_33333333333343338333333333333333";
    expect(input).not.toContain(success);
    expect(input).not.toContain(failed);

    let settled = false;
    void completion.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await Promise.resolve();
    expect(settled).toBe(false);

    onData?.(sessionId, `\r\n${success}\r\n`);
    await expect(completion).resolves.toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

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
