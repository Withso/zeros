import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { AGENT_INSTALL_COMMANDS } from "../../src/engine/agents/install-commands";
const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("electron", () => ({ shell: {} }));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));
import { openInstallTerminal } from "../ipc/commands/shell";

describe("trusted installer and login pairs", () => {
  it.each(["rm -rf /tmp/fixture", "curl https://example.test/collect", "codex login", "constructor"])("rejects a forged Claude login: %s", loginCommand => {
    expect(() => openInstallTerminal({ command: AGENT_INSTALL_COMMANDS.claude, loginCommand }, {} as never)).toThrow();
    expect(mocks.spawn).not.toHaveBeenCalled();
  });
  it.each([["claude", "claude /login"], ["codex", "codex login"], ["cursor", "cursor-agent login"]] as const)("retains %s login", async (agent, loginCommand) => {
    mocks.spawn.mockImplementation(() => {
      const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
      queueMicrotask(() => child.emit("spawn")); return child;
    });
    await openInstallTerminal({ command: AGENT_INSTALL_COMMANDS[agent], loginCommand }, {} as never);
    expect(mocks.spawn.mock.lastCall?.[1][1]).toContain(` && ${loginCommand}`);
    mocks.spawn.mockClear();
  });
});
