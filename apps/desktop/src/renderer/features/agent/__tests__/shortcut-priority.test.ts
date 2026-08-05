// The keyboard-priority tie-breaker between the agent-model menu (digit /
// ⌘digit shortcuts while open) and longer-mounted global key listeners
// (question-card digit toggles). Capture order alone can't give a
// just-opened menu precedence, so the menu claims priority and the card
// stands down while any claim is held.

import { describe, expect, it } from "vitest";

import {
  claimShortcutPriority,
  hasShortcutPriorityClaim,
} from "../shortcut-priority";

describe("shortcut-priority claims", () => {
  it("is unclaimed by default and claimed while an overlay holds it", () => {
    expect(hasShortcutPriorityClaim()).toBe(false);
    const release = claimShortcutPriority();
    expect(hasShortcutPriorityClaim()).toBe(true);
    release();
    expect(hasShortcutPriorityClaim()).toBe(false);
  });

  it("composes overlapping claims (released in any order)", () => {
    const a = claimShortcutPriority();
    const b = claimShortcutPriority();
    a();
    expect(hasShortcutPriorityClaim()).toBe(true);
    b();
    expect(hasShortcutPriorityClaim()).toBe(false);
  });

  it("release is idempotent (StrictMode double-cleanup can't underflow)", () => {
    const a = claimShortcutPriority();
    a();
    a();
    expect(hasShortcutPriorityClaim()).toBe(false);
    // A fresh claim still works after the double release.
    const b = claimShortcutPriority();
    expect(hasShortcutPriorityClaim()).toBe(true);
    b();
    expect(hasShortcutPriorityClaim()).toBe(false);
  });
});
