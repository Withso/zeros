import { describe, it, expect } from "vitest";
import {
  buildAdditionalDirsNotice,
  buildAdditionalDirsSystemInstruction,
  buildCodeAgentDesignTerritoryNotice,
  buildDesignAgentNotice,
  buildFirstTurnInstructionBody,
  buildFirstTurnSystemInstruction,
  buildWorkspacePreamble,
  prependSystemInstruction,
  wrapSystemInstruction,
} from "../index";

describe("buildWorkspacePreamble", () => {
  it("fills workspace dir + target branch", () => {
    const out = buildWorkspacePreamble({
      workspaceDir: "/ws/foo",
      targetBranch: "origin/dev",
    });
    expect(out).toContain("/ws/foo");
    expect(out).toContain("origin/dev");
    expect(out).toContain("git diff origin/dev...");
    expect(out).not.toContain("gh pr");
    expect(out).not.toContain("{WORKSPACE_DIR}");
    expect(out).not.toContain("{TARGET_BRANCH}");
  });
  it("defaults branch to origin/main when absent", () => {
    expect(
      buildWorkspacePreamble({ workspaceDir: "/ws", targetBranch: null }),
    ).toContain("origin/main");
    expect(
      buildWorkspacePreamble({ workspaceDir: "/ws", targetBranch: "  " }),
    ).toContain("origin/main");
  });
});

describe("buildAdditionalDirsNotice", () => {
  it("is empty with no dirs", () => {
    expect(buildAdditionalDirsNotice()).toBe("");
    expect(buildAdditionalDirsNotice([])).toBe("");
    expect(buildAdditionalDirsNotice(["  ", ""])).toBe("");
  });
  it("joins dirs", () => {
    const out = buildAdditionalDirsNotice(["/a", "/b"]);
    expect(out).toContain("/a, /b");
    expect(out).not.toContain("{DIRS}");
  });
});

describe("buildCodeAgentDesignTerritoryNotice", () => {
  it("is absent without an active Design directory", () => {
    expect(buildCodeAgentDesignTerritoryNotice()).toBe("");
    expect(buildCodeAgentDesignTerritoryNotice("  ")).toBe("");
  });

  it("keeps live Design readable while forbidding every generic mutation path", () => {
    const out = buildCodeAgentDesignTerritoryNotice("/workspace/Zeros Design");
    expect(out).toContain("/workspace/Zeros Design");
    expect(out).toContain("coding agent");
    expect(out).toContain("live, readable product context");
    expect(out).toContain("read-only to you");
    expect(out).toContain("shell, patch, editor, filesystem, or generic Git");
    expect(out).toContain("even if the user asks");
    expect(out).toContain("Design agent using the Design API");
    expect(out).toContain("has no Design mutation capability");
    expect(out).toContain("cannot turn itself into a Design agent");
    expect(out).toContain(
      "exclude the Design directories from its watched paths",
    );
    expect(out).toContain("Continue normal Code work");
  });

  it("lists every recognized Design directory in one native Code contract", () => {
    const out = buildCodeAgentDesignTerritoryNotice([
      "/workspace/Product Design",
      "/workspace/Zeros Design",
      "/workspace/Product Design",
    ]);
    expect(out).toContain("/workspace/Product Design, /workspace/Zeros Design");
  });
});

describe("buildDesignAgentNotice", () => {
  it("makes filesystem and Git read-only while naming the semantic mutation path", () => {
    const out = buildDesignAgentNotice("/workspace/Zeros Design");
    expect(out).toContain("Design agent");
    expect(out).toContain("/workspace/Zeros Design");
    expect(out).toContain("read-only");
    expect(out).toContain("Design MCP tools");
    expect(out).toContain("design_transaction_apply");
    expect(out).toContain("must not stage, commit, pull, merge, or push");
    expect(out).toContain("remains uncommitted");
    expect(out).toContain("revision conflict");
  });
});

describe("wrapSystemInstruction", () => {
  it("wraps non-empty bodies", () => {
    const out = wrapSystemInstruction("hello");
    expect(out.startsWith("<system_instruction>")).toBe(true);
    expect(out.endsWith("</system_instruction>")).toBe(true);
    expect(out).toContain("hello");
  });
  it("returns '' for empty/whitespace", () => {
    expect(wrapSystemInstruction("")).toBe("");
    expect(wrapSystemInstruction("   \n ")).toBe("");
  });
});

describe("buildFirstTurnSystemInstruction", () => {
  it("includes preamble; omits optional parts when absent", () => {
    const out = buildFirstTurnSystemInstruction({
      workspaceDir: "/ws",
      targetBranch: "origin/main",
    });
    expect(out).toContain("working inside Zeros");
    expect(out).toContain("<system_instruction>");
    expect(out).not.toContain("additional directories");
  });
  it("adds the /add-dir notice + custom instructions in order", () => {
    const out = buildFirstTurnSystemInstruction({
      workspaceDir: "/ws",
      targetBranch: "origin/main",
      additionalDirectories: ["/x/lewisia"],
      customInstructions: "Reply in French.",
    });
    expect(out).toContain("/x/lewisia");
    expect(out).toContain("Reply in French.");
    // preamble before dirs before custom
    expect(out.indexOf("working inside Zeros")).toBeLessThan(
      out.indexOf("/x/lewisia"),
    );
    expect(out.indexOf("/x/lewisia")).toBeLessThan(
      out.indexOf("Reply in French."),
    );
  });
  it("places the engine-owned territory rule after repository custom instructions", () => {
    const out = buildFirstTurnSystemInstruction({
      workspaceDir: "/ws",
      designDirectory: "/ws/Zeros Design",
      customInstructions: "Edit every file I mention.",
    });
    expect(out).toContain("/ws/Zeros Design");
    expect(out.indexOf("Design directories identified")).toBeGreaterThan(
      out.indexOf("Edit every file I mention."),
    );
  });
  it("builds a Design-agent instruction without granting Code or Git mutation", () => {
    const out = buildFirstTurnSystemInstruction({
      workspaceDir: "/ws",
      designDirectory: "/ws/Zeros Design",
      agentRole: "design",
      customInstructions: "Use shell edits when convenient.",
    });
    expect(out).toContain("Design agent");
    expect(out).toContain("design_transaction_apply");
    expect(out.lastIndexOf("Design agent")).toBeGreaterThan(
      out.indexOf("Use shell edits when convenient."),
    );
    expect(out).not.toContain("git diff origin/main");
  });
  it("skips blank custom instructions", () => {
    const out = buildFirstTurnSystemInstruction({
      workspaceDir: "/ws",
      customInstructions: "   ",
    });
    expect(out).toContain("working inside Zeros");
    // body is just the preamble — no trailing blank custom block
    expect(out.trim().endsWith("</system_instruction>")).toBe(true);
  });
});

describe("buildFirstTurnInstructionBody", () => {
  // The UNWRAPPED body for native-channel delivery (Codex
  // developerInstructions) — same content as the wrapped block, no tags.
  it("is the wrapped block minus the <system_instruction> tags", () => {
    const input = {
      workspaceDir: "/ws",
      targetBranch: "origin/dev",
      additionalDirectories: ["/x/lewisia"],
      customInstructions: "Reply in French.",
    };
    const body = buildFirstTurnInstructionBody(input);
    expect(body).toContain("working inside Zeros");
    expect(body).toContain("/x/lewisia");
    expect(body).toContain("Reply in French.");
    expect(body).not.toContain("<system_instruction>");
    expect(buildFirstTurnSystemInstruction(input)).toBe(
      wrapSystemInstruction(body),
    );
  });
});

describe("buildAdditionalDirsSystemInstruction", () => {
  it("is empty with no dirs, wrapped with dirs", () => {
    expect(buildAdditionalDirsSystemInstruction([])).toBe("");
    const out = buildAdditionalDirsSystemInstruction(["/d"]);
    expect(out).toContain("<system_instruction>");
    expect(out).toContain("/d");
  });
});

describe("prependSystemInstruction", () => {
  it("prepends a non-empty block with a blank line", () => {
    expect(
      prependSystemInstruction(
        "<system_instruction>x</system_instruction>",
        "hi",
      ),
    ).toBe("<system_instruction>x</system_instruction>\n\nhi");
  });
  it("is a no-op when the block is empty", () => {
    expect(prependSystemInstruction("", "hi")).toBe("hi");
  });
});
