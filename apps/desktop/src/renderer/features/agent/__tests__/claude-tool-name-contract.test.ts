import { BUILTIN_TOOL_NAMES, LEGACY_TOOL_NAME_ALIASES } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
import { sourceToolNameSites, toolNameSources, unknownClaudeToolNames } from "../../../../../../../scripts/__tests__/claude-tool-contract";

// These exact title alternatives belong to other providers or are presentation
// labels. Do not normalize them with Claude's aliases or import its Node runtime
// into the renderer. The source assertions still check every Claude branch.
const otherTitles: Record<string, Readonly<Record<string, string>>> = {
  "renderers/event-meta.ts": {
    "Chrome setup": "Zeros' displayed title for OfferChromeSetup.",
    "Searching for": "Zeros' displayed search prefix.",
    Search: "Cursor's search title.",
  },
  "renderers/tool-readiness.ts": {
    List: "Provider-neutral list-row title.",
    Shell: "Other providers' command title.",
    "Running shell command": "Zeros' displayed command title.",
    Execute: "Provider-neutral command title.",
    Subagent: "Cursor's subagent title.",
    "Spawn[ _]?agent": "Codex's spaced or underscored spawn-agent fallback.",
  },
  "renderers/subagent.ts": {
    subagent: "Cursor's subagent title.",
    "spawn_?agent": "Codex's spawn_agent/spawnagent fallback.",
    delegate: "Other providers' delegation fallback.",
  },
};

describe("installed Claude tool-name contract (renderer)", () => {
  it("covers actual Claude title matching throughout the agent feature", () => {
    const checked: string[] = [];
    const directory = new URL("../", import.meta.url);
    for (const file of toolNameSources(directory)) {
      const sites = sourceToolNameSites(file, "renderer");
      const path = file.pathname.slice(directory.pathname.length);
      if (sites.length) checked.push(path);
      expect(unknownClaudeToolNames(sites, BUILTIN_TOOL_NAMES, LEGACY_TOOL_NAME_ALIASES, otherTitles[path]), path).toEqual([]);
    }
    // These mixed title/loose-object sites must remain observable even if the
    // generic reader changes. Additional files are discovered by the walk.
    expect(checked).toEqual(expect.arrayContaining([
      "renderers/event-meta.ts", "renderers/tool-readiness.ts", "renderers/subagent.ts", "renderers/plan-body.ts",
    ]));
  });
});
