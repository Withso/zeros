// Slash-picker category tabs (All / Commands / Skills): the pure
// `matchesSlashTab` predicate and the SuggestionStore's tab-aware navigation
// (move/choose/cycle must operate on the VISIBLE, tab-filtered list so the
// highlight the store tracks lines up with what the picker renders).

import { describe, expect, it } from "vitest";

import {
  SuggestionStore,
  matchesSlashTab,
  type SuggestionItem,
} from "../composer-editor/suggestion";
import type { AvailableCommand } from "../../bridge/agent-events";

const cmd = (name: string, kind?: "command" | "skill"): AvailableCommand => ({
  name,
  description: "",
  ...(kind ? { kind } : {}),
});

describe("matchesSlashTab", () => {
  it("All matches everything", () => {
    expect(matchesSlashTab(cmd("a", "command"), "all")).toBe(true);
    expect(matchesSlashTab(cmd("b", "skill"), "all")).toBe(true);
    expect(matchesSlashTab(cmd("c"), "all")).toBe(true);
  });

  it("Skills matches only kind:skill", () => {
    expect(matchesSlashTab(cmd("b", "skill"), "skills")).toBe(true);
    expect(matchesSlashTab(cmd("a", "command"), "skills")).toBe(false);
    expect(matchesSlashTab(cmd("c"), "skills")).toBe(false); // undefined ⇒ command
  });

  it("Commands matches kind:command AND untagged entries (the default)", () => {
    expect(matchesSlashTab(cmd("a", "command"), "commands")).toBe(true);
    expect(matchesSlashTab(cmd("c"), "commands")).toBe(true);
    expect(matchesSlashTab(cmd("b", "skill"), "commands")).toBe(false);
  });
});

describe("SuggestionStore — slash tabs", () => {
  // Mixed list; order matters because the store does NOT re-sort.
  const items: SuggestionItem[] = [
    cmd("a-cmd", "command"),
    cmd("x-skill", "skill"),
    cmd("b-cmd", "command"),
    cmd("y-skill", "skill"),
  ];
  const openSlash = () => {
    const store = new SuggestionStore();
    const chosen: SuggestionItem[] = [];
    store.open("/", {
      query: "",
      items,
      status: "ready",
      command: (it) => chosen.push(it),
    });
    return { store, chosen };
  };

  it("defaults to the All tab and chooses from the full list", () => {
    const { store, chosen } = openSlash();
    expect(store.getSnapshot().slashTab).toBe("all");
    store.choose();
    expect((chosen[0] as AvailableCommand).name).toBe("a-cmd");
  });

  it("Skills tab scopes nav + choose to skill items only", () => {
    const { store, chosen } = openSlash();
    store.setSlashTab("skills");
    expect(store.getSnapshot().selectedIndex).toBe(0); // re-homed
    store.choose(); // first VISIBLE skill
    expect((chosen[0] as AvailableCommand).name).toBe("x-skill");
    store.move(1);
    store.choose();
    expect((chosen[1] as AvailableCommand).name).toBe("y-skill");
  });

  it("Commands tab scopes to commands + untagged", () => {
    const { store, chosen } = openSlash();
    store.setSlashTab("commands");
    store.choose();
    expect((chosen[0] as AvailableCommand).name).toBe("a-cmd");
    store.move(1);
    store.choose();
    expect((chosen[1] as AvailableCommand).name).toBe("b-cmd");
  });

  it("move wraps within the visible (tab-filtered) list, not the full one", () => {
    const { store } = openSlash();
    store.setSlashTab("skills"); // 2 visible skills
    store.move(-1); // wrap to the last visible
    expect(store.getSnapshot().selectedIndex).toBe(1);
  });

  it("cycleSlashTab cycles all → commands → skills → all (and back)", () => {
    const { store } = openSlash();
    store.cycleSlashTab(1);
    expect(store.getSnapshot().slashTab).toBe("commands");
    store.cycleSlashTab(1);
    expect(store.getSnapshot().slashTab).toBe("skills");
    store.cycleSlashTab(1);
    expect(store.getSnapshot().slashTab).toBe("all");
    store.cycleSlashTab(-1);
    expect(store.getSnapshot().slashTab).toBe("skills");
  });

  it("re-opening the menu resets the tab to All", () => {
    const { store } = openSlash();
    store.setSlashTab("skills");
    store.open("/", { query: "", items, status: "ready", command: () => {} });
    expect(store.getSnapshot().slashTab).toBe("all");
  });
});
