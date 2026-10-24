import { describe, expect, it } from "vitest";
import { toolNameSites, unknownClaudeToolNames } from "./claude-tool-contract";

describe("Claude tool-name source assertions", () => {
  it("reads routing names without relying on the installed SDK's spelling", () => {
    const source = `
      const EDIT_TOOLS = new Set(["Write", "MultiEdit"]);
      const CLAUDE_QUESTION_TOOL_NAME = "AskUserQuestion" satisfies "AskUserQuestion" | "TypeOnly";
      const CLAUDE_TOOL_KINDS = { Read: "read", RenamedTool: "other" };
      if (nativeTool?.name === "Monitor") {}
      if (/^(Agent|Task)$/i.test(tool?.name ?? "")) {}
      function route(name: string) { switch (name) { case "Bash": break; case "RemovedTool": break; } }
      // case "CommentOnly": is not code.
      const documentation = 'case "TextOnly": is not code';
    `;
    const sites = toolNameSites(source, "claude");
    expect(sites.map(site => site.name)).toEqual([
      "Write", "MultiEdit", "AskUserQuestion", "Read", "RenamedTool", "Monitor", "Agent", "Task", "Bash", "RemovedTool",
    ]);
    expect(unknownClaudeToolNames(sites, ["Write", "AskUserQuestion", "Read", "Monitor", "Agent", "Bash"], { Task: "Agent" })
      .map(site => site.name)).toEqual(["RenamedTool", "RemovedTool"]);
  });

  it("reads mixed renderer titles and refuses an unreviewed matcher shape", () => {
    const sites = toolNameSites(`
      const SUBAGENT_TITLE_PATTERN = /^(agent|task|spawn_?agent|delegate|subagent)$/i;
      /^Read\\s+\\S/.test(tool.title);
      /^(Grep|Glob)\\s+\\S/.test(tool.title);
      /^Glob(?:\\s|$)/i.test(tool.title);
      function isPlanReviewRequest() { /exit.?plan.?mode/i.test(title); }
      if (tool.title === "OfferChromeSetup") {}
    `, "renderer");
    expect(sites.map(site => site.name)).toEqual([
      "agent", "task", "spawn_?agent", "delegate", "subagent", "Read", "Grep", "Glob", "Glob", "exitplanmode", "OfferChromeSetup",
    ]);
    expect(() => toolNameSites("function route(name: string) { /^Future(?:Tool|Name)$/.test(name) }", "claude"))
      .toThrow("Unreviewed tool-name matcher");
  });

  it("does not confuse context category names or chat titles with native tools", () => {
    expect(toolNameSites('function category() { const name = "free space"; /\\(deferred\\)$/i.test(name); }', "claude")).toEqual([]);
    expect(toolNameSites('function chatTitle(title: string) { /^(error|fatal)\\b/i.test(title); }', "renderer")).toEqual([]);
  });

  it("rejects a renamed tool even when the SDK keeps the old spelling as an alias", () => {
    const oldOnly = [{ name: "Task", line: 1 }];
    expect(unknownClaudeToolNames(oldOnly, ["Agent"], { Task: "Agent" })).toEqual([
      { name: "Task", line: 1, aliasFor: "Agent" },
    ]);
    expect(unknownClaudeToolNames([...oldOnly, { name: "Agent", line: 2 }], ["Agent"], { Task: "Agent" })).toEqual([]);
  });
});
