// Regression (wiring): the three places ChatView decides whether a binding is
// authoritative must all ask the agents cache whether the snapshot was
// CONFIRMED, not whether it is non-null. `runLoad` publishes `[]` when a load
// fails with nothing on disk, and against that array the old `agents === null`
// checks:
//   - skipped rememberProvisionalBinding, so the guess became permanent;
//   - still ran the reconcile pass, which CONSUMED the one-shot provisional
//     record (takeProvisionalBinding) against the very list that could not
//     correct anything — burning the chat's only chance at repair;
//   - stopped re-loading, so nothing here ever asked the engine again.
//
// These are one-line gates inside React hooks and this repo has no renderer
// test harness, so they are pinned at the source like permission-mode-routing.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

function chatViewSource(): string {
  return readFileSync(
    resolve(
      process.cwd(),
      "apps/desktop/src/renderer/shell/conversation/chat-view.tsx",
    ),
    "utf8",
  );
}

describe("auto-bind against an unconfirmed registry", () => {
  it("records a provisional binding whenever the snapshot is unconfirmed", () => {
    const source = chatViewSource();
    expect(source).toContain(
      "if (!hasConfirmedAgents()) rememberProvisionalBinding(chat.id, prior);",
    );
    expect(source).not.toContain(
      "if (agents === null) rememberProvisionalBinding",
    );
  });

  it("never spends the one-shot provisional record on an unconfirmed list", () => {
    const source = chatViewSource();
    const start = source.indexOf(
      "const prior = takeProvisionalBinding(chatId)",
    );
    expect(start).toBeGreaterThan(-1);
    const guard = source.slice(source.lastIndexOf("useEffect", start), start);
    expect(guard).toContain("!hasConfirmedAgents()");
  });

  it("keeps asking the engine while the snapshot is still a guess", () => {
    const source = chatViewSource();
    expect(source).toContain(
      'if (hasConfirmedAgents() || bridgeStatus !== "connected") return;',
    );
  });
});
