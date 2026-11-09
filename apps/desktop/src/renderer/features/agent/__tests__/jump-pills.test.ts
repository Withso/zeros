import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const read = (path: string) =>
  readFileSync(resolve(process.cwd(), "apps/desktop/src/renderer/features/agent", path), "utf8");

// 2026-11-09: the owner removed the "Jump to your prompt" pill. Jump to
// latest, above the composer, stays.
describe("jump pills", () => {
  it("offers only Jump to latest", () => {
    const pills = read("jump-pills.tsx");
    expect(pills).not.toMatch(/JumpToPromptPill|Jump to your prompt|Your prompt/);
    expect(pills).toContain("export const JumpToLatestButton");
  });

  it("leaves no trace of the pill in the chat or its turns", () => {
    const chat = read("agent-chat.tsx");
    expect(chat).not.toMatch(/JumpToPromptPill|activePromptEl|setActivePromptEl/);
    expect(chat).toContain("<JumpToLatestButton");
    expect(read("transcript-turn.tsx")).not.toContain("setActivePromptEl");
  });
});
