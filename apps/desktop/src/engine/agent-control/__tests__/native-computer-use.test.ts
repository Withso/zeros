import type { ComputerUseOwner } from "@zeros/protocol/computer-use-tools";
import { describe, expect, it, vi } from "vitest";

import { NativeComputerUseReports } from "../native-computer-use";

const OWNER = {
  workspaceId: "workspace-1",
  conversationId: "conversation-1",
} as ComputerUseOwner;

describe("built-in computer use reports", () => {
  it("names the chat once and still ends it after its routing is gone", async () => {
    const send = vi.fn(async () => true);
    const reports = new NativeComputerUseReports(send);
    const resolve = vi.fn(() => ({ owner: OWNER, agent: "codex" as const }));
    await reports.update("execution-1", true, resolve);
    await reports.update("execution-1", true, resolve);
    await reports.update("execution-1", false, () => null);
    await reports.update("execution-1", false, () => null);
    expect(resolve).toHaveBeenCalledOnce();
    expect(send.mock.calls).toEqual([
      [OWNER, "codex", true],
      [OWNER, "codex", true],
      [OWNER, "codex", false],
    ]);
  });

  it("skips an execution without a Local conversation", async () => {
    const send = vi.fn(async () => true);
    const reports = new NativeComputerUseReports(send);
    await reports.update("execution-1", true, () => null);
    await reports.update("execution-1", false, () => null);
    expect(send).not.toHaveBeenCalled();
  });

  it("delivers one chat's reports in order even when a send is slow or fails", async () => {
    const delivered: boolean[] = [];
    let releaseFirst!: () => void;
    const send = vi.fn(
      (_owner: ComputerUseOwner, _agent: string, active: boolean) =>
        active
          ? new Promise<boolean>((resolve) => {
              releaseFirst = () => {
                delivered.push(active);
                resolve(true);
              };
            })
          : (delivered.push(active), Promise.reject(new Error("offline"))),
    );
    const reports = new NativeComputerUseReports(send);
    const resolve = () => ({ owner: OWNER, agent: "codex" as const });
    const started = reports.update("execution-1", true, resolve);
    const ended = reports.update("execution-1", false, resolve);
    await Promise.resolve();
    expect(delivered).toEqual([]);
    releaseFirst();
    await Promise.all([started, ended]);
    expect(delivered).toEqual([true, false]);
  });
});
