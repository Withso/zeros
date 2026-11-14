import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DESIGN_RULES, PREVIOUS_CONTRACT_DESIGN_RULES, PREVIOUS_PAGED_DESIGN_RULES, PREVIOUS_PER_PAGE_DESIGN_RULES } from "../design-rules";
import { DESIGN_DIRECTORY_NAME, initializeDesignDocument } from "../document";
import { ensureDesignMetadataLayout } from "../metadata";

// The real authoring lifecycle path that refreshes a paged directory's
// generated rules.md, over the files a checkout holds today.
describe("generated rules.md in a paged Design directory", () => {
  let root: string;
  const rules = () => path.join(root, DESIGN_DIRECTORY_NAME, "rules.md");
  const project = "\n## Zeros product designs\nThis directory holds mockups of the app itself.\n";

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "zeros-design-rules-"));
    await initializeDesignDocument(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("starts a new directory with the authoring contract", async () => {
    expect(await readFile(rules(), "utf8")).toBe(DESIGN_RULES);
  });

  it.each([
    ["the first authoring contract", PREVIOUS_CONTRACT_DESIGN_RULES],
    ["the per-page rules", PREVIOUS_PER_PAGE_DESIGN_RULES],
    ["the directory-wide limit rules", PREVIOUS_PAGED_DESIGN_RULES],
  ])("upgrades %s and keeps the project's appended text", async (_name, previous) => {
    await writeFile(rules(), previous + project);
    expect(ensureDesignMetadataLayout(root, DESIGN_DIRECTORY_NAME)).toEqual([`${DESIGN_DIRECTORY_NAME}/rules.md`]);
    expect(await readFile(rules(), "utf8")).toBe(DESIGN_RULES + project);
    expect(ensureDesignMetadataLayout(root, DESIGN_DIRECTORY_NAME)).toEqual([]);
  });

  it("leaves a hand-edited rules.md alone", async () => {
    const edited = PREVIOUS_PER_PAGE_DESIGN_RULES.replace("Do not gitignore it.", "Never gitignore it.") + project;
    await writeFile(rules(), edited);
    expect(ensureDesignMetadataLayout(root, DESIGN_DIRECTORY_NAME)).toEqual([]);
    expect(await readFile(rules(), "utf8")).toBe(edited);
  });
});
