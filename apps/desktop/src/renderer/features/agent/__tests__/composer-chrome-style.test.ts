import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

function code(relativePath: string): string {
  return readFileSync(
    fileURLToPath(new URL(relativePath, import.meta.url)),
    "utf8",
  )
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

describe("composer chrome", () => {
  it("wears border1 at rest and border2 while focused", () => {
    // The composer card is the ONE surface whose border moves on focus, and it
    // moves QUIETLY: border1 → border2, never the near-white
    // highlighted-bright that plain inputs use. Both halves of the pair live in
    // a single class string, so assert the whole prefix.
    expect(code("../agent-chat.tsx")).toContain(
      "border-border1 bg-bg2 focus-within:border-border2 relative flex w-full",
    );
  });

  it("keeps the drag and guarded states off the focus border", () => {
    const agentChat = code("../agent-chat.tsx");

    // Dragging files over the card and the guarded (plan/ask) frame both
    // override the border with `!`, so a focused composer looks identical to an
    // unfocused one in those states.
    expect(agentChat).toContain(
      '"!border-border2 ring-highlighted-bright/30 border-dashed ring-2"',
    );
    expect(agentChat).toContain('"!border-transparent"');
  });

  it("paints the sent user message on the composer's own surface", () => {
    // --highlighted-bg is aliased to --bg2 in neutral Dark (see §9.1 of
    // styles/zeros-foundation.md), so the bubble and the composer read as one
    // surface family; border1 is what draws the bubble's edge on either.
    expect(code("../turn-container.tsx")).toContain(
      '"border-border1 bg-highlighted-bg"',
    );
  });
});
