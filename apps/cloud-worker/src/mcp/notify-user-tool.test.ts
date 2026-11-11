import { describe, expect, it, vi } from "vitest";
import type { NotifyUserInput } from "@zeros/protocol/notify-user";
import type { NotifyUserOutcome } from "../notify-user/service";
import { WorkspaceAgentTools } from "./agent-tools";

const base = { assertCurrent: () => {}, terminalOutput: async () => undefined, diff: async () => ({ text: "", truncated: false }) };
function fixture(outcome: NotifyUserOutcome = "sent") {
  const notify = vi.fn(async (_input: NotifyUserInput, _signal: AbortSignal) => outcome);
  return { tools: new WorkspaceAgentTools({ ...base, notifyUser: { notify } }), notify };
}
const call = (tools: WorkspaceAgentTools, input: unknown) =>
  tools.callTool("NotifyUser", input, new AbortController().signal) as Promise<{ isError?: boolean; content: Array<{ text: string }> }>;
const input = { title: "Ready for review", message: "The login fix is ready.", kind: "review" };

describe("NotifyUser", () => {
  it("is offered only with notify-user-v1, and says it is once per turn and that the title can show on a lock screen", async () => {
    const definition = fixture().tools.listTools().find(tool => tool.name === "NotifyUser");
    expect(definition?.description).toMatch(/once.*turn/i);
    expect(definition?.description).toMatch(/lock screen/i);
    expect(definition?.inputSchema).toMatchObject({ required: ["title", "message", "kind"], additionalProperties: false });
    const without = new WorkspaceAgentTools(base);
    expect(without.listTools().map(tool => tool.name)).not.toContain("NotifyUser");
    await expect(without.callTool("NotifyUser", input, new AbortController().signal)).rejects.toThrow();
  });

  it("validates the input before anything is sent", async () => {
    const f = fixture();
    for (const bad of [{ ...input, title: "x".repeat(81) }, { ...input, kind: "fyi" }, { ...input, extra: 1 }, {}]) {
      const result = await call(f.tools, bad);
      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toContain("INVALID_INPUT");
    }
    expect(f.notify).not.toHaveBeenCalled();
  });

  it("tells the agent what happened, without failing the turn when only the open app was reached", async () => {
    const texts: Record<string, { text: string; isError: boolean }> = {};
    for (const outcome of ["sent", "unreachable", "already_notified", "rate_limited", "no_turn"] as const) {
      const f = fixture(outcome); const result = await call(f.tools, input);
      if (outcome === "sent") expect(f.notify).toHaveBeenCalledWith(input, expect.any(AbortSignal));
      texts[outcome] = { text: result.content[0]!.text, isError: !!result.isError };
    }
    expect(texts.sent).toEqual({ text: expect.stringMatching(/^Notified the person: Ready for review\./), isError: false });
    expect(texts.unreachable).toEqual({ text: expect.stringMatching(/open Zeros app/), isError: false });
    expect(texts.already_notified).toEqual({ text: expect.stringMatching(/Already notified this turn/), isError: false });
    expect(texts.rate_limited!.isError).toBe(true);
    expect(texts.no_turn!.isError).toBe(true);
  });
});
