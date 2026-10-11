import { describe, expect, it } from "vitest";

import { retainRecentViewKeySet } from "../../retained-view-keys";
import { activeBrowserDeckKeys, browserViewKey } from "../browser-deck-keys";

const LIMIT = 8;
const localScope = "/Users/me/app";
const cloudScope =
  "cloud://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222";

function deck(scope: string, floats: readonly { scope: string; tabId: string }[]) {
  const tabIds = Array.from({ length: 10 }, (_, index) => `browser-${index}`);
  const scopeKeys = tabIds.map((id) => browserViewKey(scope, id));
  const keys = activeBrowserDeckKeys({
    scopeKeys,
    availableKeys: new Set(scopeKeys),
    activeScope: scope,
    activeId: "browser-9",
    floats,
  });
  return retainRecentViewKeySet([], keys, LIMIT, new Set(scopeKeys));
}

describe.each([
  ["Local", localScope],
  ["cloud", cloudScope],
])("retained Browser deck in a %s workspace", (_label, scope) => {
  it("evicts the oldest tabs when the scope has more tabs than the deck holds", () => {
    const retained = deck(scope, []);
    expect(retained).toHaveLength(LIMIT);
    expect(retained).not.toContain(browserViewKey(scope, "browser-0"));
    expect(retained.at(-1)).toBe(browserViewKey(scope, "browser-9"));
  });

  it("keeps a floated tab mounted even when it would otherwise be evicted", () => {
    const retained = deck(scope, [{ scope, tabId: "browser-0" }]);
    expect(retained).toHaveLength(LIMIT);
    expect(retained).toContain(browserViewKey(scope, "browser-0"));
    expect(retained.at(-1)).toBe(browserViewKey(scope, "browser-9"));
  });

  it("ignores a float whose tab is gone", () => {
    const retained = deck(scope, [{ scope, tabId: "closed" }]);
    expect(retained).not.toContain(browserViewKey(scope, "closed"));
  });
});
