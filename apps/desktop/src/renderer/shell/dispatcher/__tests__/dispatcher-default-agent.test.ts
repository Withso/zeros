// Regression: the new-workspace dispatcher must never be left without a
// selection. `pickDefaultAgentId` gained an enabled filter, so it now returns
// null once every runnable agent is toggled off in Settings → Agents — and the
// dispatcher's seeding effect bails on null, which permanently disables Create
// and hides the model picker with nothing on screen to explain why.
//
// Every chat spawn path resolves through `pickAgentForNewChat`, whose documented
// last tier is "any registry agent … an agent the user hid still beats a dead
// pane, and the pill lets them switch". The dispatcher creates chats too, so it
// follows the same chain.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { BridgeRegistryAgent } from "../../../platform/bridge/messages";
import {
  pickAgentForNewChat,
  pickDefaultAgent,
} from "../../../features/settings/default-agent";

function installLocalStorage(): void {
  const store = new Map<string, string>();
  (globalThis as { localStorage?: Storage }).localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
    clear: () => store.clear(),
    key: () => null,
    length: 0,
  } as unknown as Storage;
}

const agent = (id: string): BridgeRegistryAgent =>
  ({ id, name: id, authenticated: true }) as unknown as BridgeRegistryAgent;

function dispatcherSource(): string {
  return readFileSync(
    resolve(
      process.cwd(),
      "apps/desktop/src/renderer/shell/dispatcher/dispatcher-composer.tsx",
    ),
    "utf8",
  );
}

describe("dispatcher default-agent seeding", () => {
  beforeEach(installLocalStorage);
  afterEach(() => {
    delete (globalThis as { localStorage?: Storage }).localStorage;
  });

  it("still resolves an agent when the user has disabled every one of them", () => {
    const registry = [agent("codex"), agent("claude"), agent("cursor")];
    localStorage.setItem(
      "zeros.agent.enabledAgents",
      JSON.stringify({ ids: [] }),
    );

    // The strict picker is correct to refuse — nothing is enabled.
    expect(pickDefaultAgent(registry)).toBeNull();
    // The spawn chain still binds, which is what keeps the surface usable.
    expect(pickAgentForNewChat(registry)?.id).toBe("codex");
  });

  it("seeds the dispatcher through the relaxed new-chat chain", () => {
    const source = dispatcherSource();
    expect(source).toContain("const agent = pickAgentForNewChat(agents);");
    expect(source).not.toContain("pickDefaultAgent(agents)");
  });
});
