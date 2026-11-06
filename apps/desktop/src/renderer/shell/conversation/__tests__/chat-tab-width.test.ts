import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const CHAT_TABS = "apps/desktop/src/renderer/shell/conversation/chat-tabs.tsx";

function source(): string {
  return readFileSync(resolve(process.cwd(), CHAT_TABS), "utf8");
}

/** The literal class string assigned to a top-level `const NAME = "…"`. */
function classConstant(src: string, name: string): string {
  const match = new RegExp(`const ${name} =\\s*\\n?\\s*"([^"]*)"`).exec(src);
  if (!match) throw new Error(`${name} not found`);
  return match[1];
}

describe("chat tab width", () => {
  // 2026-11-06 direction (Zeros Design v378): a chat tab is content-sized from
  // 70px up to a 176px cap, then truncates. The synthetic Untitled tab shares
  // the cap so the strip never re-flows when the first real chat replaces it.
  it.each(["TAB_BASE_CLS", "TAB_UNTITLED_CLS"])("caps %s at 176px above a 70px floor", (name) => {
    const classes = classConstant(source(), name).split(/\s+/);
    expect(classes).toContain("min-w-[70px]");
    expect(classes.filter((cls) => cls.startsWith("max-w-"))).toEqual(["max-w-44"]);
  });
});
