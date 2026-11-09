import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");
const agentChat = () => read("apps/desktop/src/renderer/features/agent/agent-chat.tsx");

/** The one `className="…"` literal that starts with `prefix`, as utilities. */
function classLiteral(src: string, prefix: string): string[] {
  const hits = [...src.matchAll(/className="([^"]*)"/g)]
    .map((match) => match[1])
    .filter((value) => value.startsWith(prefix));
  expect(hits).toHaveLength(1);
  return hits[0].split(/\s+/);
}

describe("transcript top edge", () => {
  // 2026-11-06 direction (Zeros Design v378): in every pane the conversation
  // fades out over 32px right under its tab strip, starting at the strip's
  // edge like the fade above the composer, and the first message starts below
  // that fade so nothing sits under it until the transcript scrolls.
  it("fades the transcript out over 32px from the strip's edge", () => {
    const fade = classLiteral(agentChat(), "pointer-events-none absolute inset-x-0 top-0 z-1");
    expect(fade).toEqual(
      expect.arrayContaining(["h-8", "bg-gradient-to-b", "from-(--pane-bg)", "to-transparent"]),
    );
    expect(fade.filter((cls) => cls.startsWith("via-"))).toEqual([]);
  });

  it("starts the first message 32px down, below the fade", () => {
    const column = classLiteral(agentChat(), "zeros-agent-messages");
    expect(column).toContain("pt-8");
    expect(column).not.toContain("pt-3");
    // Read-only history's "No chat history." row is the same column.
    expect(read("apps/desktop/src/renderer/shell/conversation/conversation-pane.tsx")).toContain(
      'className="mx-auto w-full max-w-[856px] flex-1 px-7 pt-8"',
    );
  });
});
