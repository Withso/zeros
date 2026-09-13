import { describe, expect, it, vi } from "vitest";
import type { ToolArtwork } from "@zeros/protocol/tool-artwork";
import { CodexAppServerTranslator } from "../app-server-translator";
import type { SessionNotification } from "../../../types";

function fixture() {
  const emitted: SessionNotification[] = [];
  const pending: ((artwork: ToolArtwork) => void)[] = [];
  const translator = new CodexAppServerTranslator({
    sessionId: "session",
    emit: (event) => emitted.push(event),
    resolveArtwork: () => new Promise((resolve) => pending.push(resolve)),
  });
  const item = {
    type: "mcpToolCall",
    id: "call",
    server: "codex_apps",
    tool: "notes.find",
    arguments: {},
    status: "inProgress",
  };
  const artwork = (name: string) => ({
    icon: "https://cdn.example.com/icon.png",
    name,
  });
  return { emitted, pending, translator, item, artwork };
}

describe("late Codex tool artwork", () => {
  it("never reverts a completed call's result or status and ignores superseded identity", async () => {
    const f = fixture();
    f.translator.handle("item/started", { item: f.item });
    f.translator.handle("item/completed", {
      item: {
        ...f.item,
        status: "failed",
        error: { message: "Tool denied" },
        appContext: { connectorId: "actual-app" },
      },
    });
    f.pending[0]!(f.artwork("stale"));
    await Promise.resolve();
    expect(f.emitted).toHaveLength(2);
    f.pending[1]!(f.artwork("current"));
    await vi.waitFor(() => expect(f.emitted).toHaveLength(3));
    expect(f.emitted[1]?.update).toMatchObject({ status: "failed" });
    const update = f.emitted[2]!.update;
    expect(update).toMatchObject({
      sessionUpdate: "tool_call_update",
      rawInput: {
        appContext: { connectorId: "actual-app" },
        _zerosToolArtwork: { name: "current" },
      },
    });
    expect(update).not.toHaveProperty("status");
    expect(update).not.toHaveProperty("rawOutput");
  });
  it("discards a previous turn's pending artwork", async () => {
    const f = fixture();
    f.translator.handle("item/started", { item: f.item });
    f.translator.startTurn();
    f.pending[0]!(f.artwork("old turn"));
    await Promise.resolve();
    expect(f.emitted).toHaveLength(1);
  });
});
