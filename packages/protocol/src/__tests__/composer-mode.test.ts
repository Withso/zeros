import { describe, expect, it } from "vitest";
import { composerModeInstruction } from "../composer-mode";

describe("native Design authoring instructions", () => {
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
    expect(instruction).toContain("Design writes require Design mode");
    expect(instruction).toContain("Provider Plan and permission settings still apply");
  });
  it("uses API authoring when the execution boundary forbids native Design writes", () => {
    const instruction = composerModeInstruction("design", 6, "api");
    expect(instruction).toContain("design_transaction_apply");
    expect(instruction).toContain("design_frame_create");
    expect(instruction).toContain("expectedRevision=6");
    expect(instruction).toContain("Native file writes to Design are unavailable");
    expect(instruction).not.toContain("Use your normal Read, Write, Edit");
    expect(instruction).not.toContain("No Design API apply or publish");
  });
});
