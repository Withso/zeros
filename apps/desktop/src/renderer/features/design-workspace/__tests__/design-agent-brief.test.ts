import { describe, expect, it } from "vitest";

import { designSourceFixBrief, designSyncBrief } from "../design-agent-brief";

const source = {
  id: "app",
  title: "App styles",
  kind: "tailwind",
  path: "src/index.css",
  status: "error" as const,
  messages: [
    { level: "info" as const, text: "Compiled with Tailwind CSS 4.2.1." },
    { level: "error" as const, text: "src/index.css does not exist.", action: "agent" as const },
  ],
  themes: [],
  tokens: [],
  bytes: 0,
  revision: null,
};

describe("Design agent briefs", () => {
  it("asks for syncing set up through the skill, with the directory and what exists", () => {
    const empty = designSyncBrief("Shop - Design", []);
    expect(empty.label).toBe("Set up style syncing");
    expect(empty.text).toContain('Set up style syncing for the Design directory "Shop - Design".');
    expect(empty.text).toContain('Follow "Sync the application\'s styles" in the Zeros Design skill');
    expect(empty.text).toContain('"Shop - Design/meta/canvas.json"');
    expect(empty.text).toContain("`zeros-engine design styles`");
    expect(empty.text).toContain("Ask before changing application code.");
    expect(empty.text).toContain("declares no style sources yet");
    const existing = designSyncBrief("Shop - Design", [source]);
    expect(existing.label).toBe("Update style syncing");
    expect(existing.text).toContain("- app (tailwind, src/index.css): error — src/index.css does not exist.");
    expect(existing.text).not.toContain("Compiled with Tailwind");
  });

  it("names the one source to fix and what it reports", () => {
    const brief = designSourceFixBrief("Shop - Design", source);
    expect(brief.label).toBe("Fix style source App styles");
    expect(brief.text).toContain('The style source "app" in the Design directory "Shop - Design" needs fixing:');
    expect(brief.text).toContain("src/index.css does not exist.");
    expect(brief.text).toContain("Ask before changing application code.");
  });

  it("names the fonts list when App fonts needs fixing", () => {
    const brief = designSourceFixBrief("Shop - Design", { ...source, id: "@fonts", title: "App fonts", kind: "fonts", path: "fonts/Brand.woff2" });
    expect(brief.text).toContain('The App fonts (the `fonts` list) in the Design directory "Shop - Design" need fixing:');
  });
});
