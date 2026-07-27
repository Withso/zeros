import { describe, expect, it } from "vitest";

import {
  composerCommandsFor,
  getBuiltinCommands,
  mergeCommands,
  slashCommandKind,
} from "../builtin-commands";
import type { AvailableCommand } from "../agent-events";

const AGENTS = ["claude", "codex", "cursor"];

describe("getBuiltinCommands", () => {
  it("returns a non-empty list for every supported agent", () => {
    for (const id of AGENTS) {
      const list = getBuiltinCommands(id);
      expect(list.length, `${id} should have curated commands`).toBeGreaterThan(0);
      for (const cmd of list) {
        expect(cmd.name).toBeTruthy();
        expect(typeof cmd.description).toBe("string");
      }
    }
  });

  it("has no duplicate command names within an agent", () => {
    for (const id of AGENTS) {
      const names = getBuiltinCommands(id).map((c) => c.name);
      expect(new Set(names).size, `${id} has duplicate command names`).toBe(names.length);
    }
  });

  it("returns [] for unknown / null / undefined agent ids", () => {
    expect(getBuiltinCommands("nope")).toEqual([]);
    expect(getBuiltinCommands(null)).toEqual([]);
    expect(getBuiltinCommands(undefined)).toEqual([]);
  });

  it("returns fresh copies (callers cannot mutate the table)", () => {
    const a = getBuiltinCommands("claude");
    a[0].name = "MUTATED";
    const b = getBuiltinCommands("claude");
    expect(b[0].name).not.toBe("MUTATED");
  });
});

describe("mergeCommands", () => {
  it("dedupes by name with LATER lists winning, sorted alphabetically", () => {
    const a: AvailableCommand[] = [
      { name: "b", description: "from a" },
      { name: "a", description: "from a" },
    ];
    const b: AvailableCommand[] = [{ name: "a", description: "from b" }];
    const out = mergeCommands(a, b);
    expect(out.map((c) => c.name)).toEqual(["a", "b"]); // sorted
    expect(out.find((c) => c.name === "a")?.description).toBe("from b"); // later wins
  });

  it("skips entries without a name and tolerates empty lists", () => {
    const out = mergeCommands(
      [{ name: "", description: "blank" } as AvailableCommand, { name: "ok", description: "" }],
      [],
    );
    expect(out.map((c) => c.name)).toEqual(["ok"]);
  });
});

describe("composerCommandsFor", () => {
  it("unions curated built-ins with discovered (discovered wins on clash for non-inline)", () => {
    const discovered: AvailableCommand[] = [
      { name: "review", description: "DISCOVERED override" }, // clashes; non-inline → discovered wins
      { name: "my-custom", description: "user command" }, // net-new
    ];
    const out = composerCommandsFor("claude", discovered);
    expect(out.find((c) => c.name === "review")?.description).toBe("DISCOVERED override");
    expect(out.some((c) => c.name === "my-custom")).toBe(true);
    // curated entries still present
    expect(out.some((c) => c.name === "init")).toBe(true);
  });

  it("keeps Zeros' curated description for INLINE commands (Zeros owns the behavior)", () => {
    // /clear + /compact are handled inline by Zeros, so the picker must show
    // OUR description (what Zeros actually does) — not the agent CLI's text
    // from supportedCommands(), even though discovered normally wins.
    const discovered: AvailableCommand[] = [
      { name: "clear", description: "CLI: clears the transcript" },
      { name: "compact", description: "CLI: compacts" },
    ];
    const out = composerCommandsFor("claude", discovered);
    expect(out.find((c) => c.name === "clear")?.description).toContain(
      "reopen the chat to resume",
    );
    expect(out.find((c) => c.name === "compact")?.description).toBe(
      "Summarize the conversation to free up context",
    );
  });

  it("falls back to the curated floor when nothing is discovered (new-chat)", () => {
    const out = composerCommandsFor("codex", []);
    expect(out.length).toBeGreaterThan(0);
    expect(out.some((c) => c.name === "init")).toBe(true);
  });

  it("is never empty for a known agent (so typing / always opens)", () => {
    for (const id of AGENTS) {
      expect(composerCommandsFor(id, []).length).toBeGreaterThan(0);
    }
  });

  it("returns discovered-only for an unknown agent", () => {
    const out = composerCommandsFor(null, [{ name: "x", description: "" }]);
    expect(out.map((c) => c.name)).toEqual(["x"]);
  });

  it("dropped /cost from the Claude curated list (user: there is no /cost)", () => {
    expect(getBuiltinCommands("claude").some((c) => c.name === "cost")).toBe(false);
  });
});

describe("slashCommandKind (Claude command behavior)", () => {
  it("classifies the inline actions", () => {
    for (const name of ["plan", "fast", "ultracode", "add-dir", "compact"]) {
      expect(slashCommandKind("claude", name)).toBe("inline");
    }
  });
  it("classifies interactive TUI commands as terminal", () => {
    for (const name of ["mcp", "agents", "login", "permissions"]) {
      expect(slashCommandKind("claude", name)).toBe("terminal");
    }
  });
  it("defaults everything else (and custom commands) to text", () => {
    for (const name of ["review", "init", "context", "mcp-status", "my-custom"]) {
      expect(slashCommandKind("claude", name)).toBe("text");
    }
  });
  it('classifies /clear as inline (close-and-new-chat)', () => {
    expect(slashCommandKind("claude", "clear")).toBe("inline");
  });
  it("/model is NOT inline yet (falls through to text)", () => {
    expect(slashCommandKind("claude", "model")).toBe("text");
  });
  it("codex: /compact is inline (real thread/compact/start — §3.5 Task A); everything else text", () => {
    expect(slashCommandKind("codex", "compact")).toBe("inline");
    expect(slashCommandKind("openai-codex", "compact")).toBe("inline");
    for (const name of ["plan", "clear", "mcp", "my-custom"]) {
      expect(slashCommandKind("codex", name)).toBe("text");
    }
  });
  it("cursor (and unknown agents) always get text (behaviors not wired yet)", () => {
    for (const id of ["cursor", null]) {
      expect(slashCommandKind(id, "plan")).toBe("text");
      expect(slashCommandKind(id, "compact")).toBe("text");
    }
  });
});

describe("kind discriminator (command vs skill)", () => {
  it('stamps every curated built-in as kind:"command"', () => {
    for (const id of AGENTS) {
      for (const cmd of getBuiltinCommands(id)) {
        expect(cmd.kind, `${id}/${cmd.name}`).toBe("command");
      }
    }
  });

  it("mergeCommands preserves kind, and the winner's kind survives a clash", () => {
    const skills: AvailableCommand[] = [
      { name: "wrangler", description: "skill", kind: "skill" },
      { name: "shared", description: "as skill", kind: "skill" },
    ];
    const commands: AvailableCommand[] = [
      { name: "review", description: "cmd", kind: "command" },
      { name: "shared", description: "as command", kind: "command" },
    ];
    // commands are listed LAST → they win the "shared" clash (kind follows).
    const out = mergeCommands(skills, commands);
    expect(out.find((c) => c.name === "wrangler")?.kind).toBe("skill");
    expect(out.find((c) => c.name === "review")?.kind).toBe("command");
    expect(out.find((c) => c.name === "shared")?.kind).toBe("command");
  });

  it("composerCommandsFor keeps the floor as commands and discovered skills as skills", () => {
    const out = composerCommandsFor("claude", [
      { name: "wrangler", description: "Cloudflare Workers CLI", kind: "skill" },
    ]);
    expect(out.find((c) => c.name === "wrangler")?.kind).toBe("skill");
    expect(out.find((c) => c.name === "init")?.kind).toBe("command");
  });
});
