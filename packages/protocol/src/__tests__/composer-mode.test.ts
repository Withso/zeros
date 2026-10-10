import { describe, expect, it } from "vitest";
import { composerModeInstruction } from "../composer-mode";

describe("native Design authoring instructions", () => {
  it.each(["code", "design"] as const)("describes native page membership in %s intent", mode => {
    const instruction = composerModeInstruction(mode);
    expect(instruction).toContain("meta/canvas.json");
    expect(instruction).toContain("<page.folder>/<name>.html");
    expect(instruction).toContain("that page's frames array");
    expect(instruction).not.toContain("pages[0].frames");
  });
  it("requires an API pageId for multi-page frame creation and duplication", () => {
    const instruction = composerModeInstruction("design", undefined, "api");
    expect(instruction).toContain("pageId");
    expect(instruction).toContain("design_frame_duplicate");
    expect(instruction).toContain("several pages");
    expect(instruction).toContain("meta/design.toml");
  });
  it("authorizes ordinary provider file tools without an API save loop", () => {
    const instruction = composerModeInstruction("design", 4);
    expect(instruction).toContain("Write, Edit, patch and Bash");
    expect(instruction).toContain("canvas.json");
    expect(instruction).toContain("expectedRevision=4");
    expect(instruction).toContain("No Design API apply or publish");
    expect(instruction).not.toContain("Never write Design source");
    expect(instruction).not.toContain("apply semantic edits");
  });
  it("keeps Code inspection and provider permissions independent", () => {
    const instruction = composerModeInstruction("code", 5);
    expect(instruction).toContain("inspection");
    expect(instruction).toContain("explicitly requested Design source edits");
    expect(instruction).not.toContain("Design writes require Design mode");
    expect(instruction).toContain("Provider Plan and permission settings still apply");
  });
  it("keeps the cloud API authoring workflow and exact revision", () => {
    const instruction = composerModeInstruction("design", 6, "api");
    expect(instruction).toContain("design_transaction_apply");
    expect(instruction).toContain("design_frame_create");
    expect(instruction).toContain("expectedRevision=6");
    expect(instruction).not.toContain("Use your normal Read, Write, Edit");
    expect(instruction).not.toContain("No Design API apply or publish");
  });
  it.each(["code", "design"] as const)("states cloud %s authoring policy without claiming OS write denial", mode => {
    const instruction = composerModeInstruction(mode, 7, "api");
    expect(instruction).toContain("Cloud retains API authoring for now as product policy");
    expect(instruction).toContain("The workspace VM is the isolation boundary");
    expect(instruction).toContain("no agent sandbox");
    expect(instruction).toContain("share the non-root engine identity");
    expect(instruction).toContain("can read engine and other-conversation state");
    expect(instruction).not.toContain("engine data stays private");
    expect(instruction).not.toContain("Native file writes to Design are unavailable");
    expect(instruction).toContain("Provider Plan and permission settings still apply");
    expect(instruction).toContain("expectedRevision=7");
  });
});
