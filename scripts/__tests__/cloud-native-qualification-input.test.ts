import { describe, expect, it } from "vitest";
import { parseNativeQualificationInput, nativeQualificationPermission } from "../cloud-workspace-validation/lib/native-qualification-input";
const now = 1_800_000_000_000;
const valid = { version: 1, expiresAtMs: now + 60_000, sourceCommit: "a".repeat(40), buildSha256: "b".repeat(64),
  model: "test-model", material: { kind: "cursor-api-key", apiKey: "synthetic-qualification-key" } };
describe("private cloud native qualification input", () => {
  const codex = { kind: "codex-chatgpt", accessToken: "synthetic-original-access", accountId: "fixture", expiresAt: now / 1000 + 3600 };
  const renewed = { ...codex, accessToken: "synthetic-renewed-access" };
  it("accepts bounded explicit provider credentials and immutable build identity", () => {
    expect(parseNativeQualificationInput(valid, now).material.kind).toBe("cursor-api-key");
  });
  it("accepts two bound access versions for a separate Codex renewal qualification", () => {
    const result = parseNativeQualificationInput({ ...valid, material: codex, renewedCodex: renewed }, now);
    expect(result.renewedCodex?.accessToken).toBe(renewed.accessToken);
  });
  it.each([
    { material: codex },
    { material: codex, renewedCodex: codex },
    { material: codex, renewedCodex: { ...renewed, accountId: "another-account" } },
    { material: codex, renewedCodex: { ...renewed, expiresAt: now / 1000 + 1 } },
    { material: codex, renewedCodex: { ...renewed, refreshToken: "synthetic-refresh-secret" } },
    { material: { ...codex, refreshToken: "synthetic-refresh-secret" }, renewedCodex: renewed },
    { renewedCodex: renewed },
  ])("never treats unbound or refresh-bearing input as Codex access evidence", change => {
    expect(() => parseNativeQualificationInput({ ...valid, ...change }, now)).toThrow("Invalid private native qualification input");
  });
  it.each([
    { expiresAtMs: now }, { expiresAtMs: now + 3_600_000 }, { buildSha256: "mutable" },
    { sourceCommit: "main" }, { model: "a; command" }, { unknownAuthority: true },
    { material: { kind: "cursor-api-key", apiKey: "short" } },
    { material: { kind: "codex-chatgpt", accessToken: "synthetic-qualification-key", accountId: "fixture", expiresAt: now / 1000 + 3600 } },
  ])("rejects incomplete, expired or unsupported evidence input: %o", (change) => {
    expect(() => parseNativeQualificationInput({ ...valid, ...change }, now)).toThrow("Invalid private native qualification input");
  });
});

describe("native qualification tool approvals", () => {
  const files = { challenge: ".test.challenge", edited: ".test.edited", executed: ".test.executed" };
  const permission = (rawInput: unknown, title = "Read") => ({
    toolCall: { title, rawInput },
    options: [{ kind: "allow_once", optionId: "allow_once" }],
  });
  it.each([
    permission({ file_path: files.challenge }),
    permission({ file_path: files.edited, content: "test-marker" }, "Write"),
    permission({ command: "cat '.test.challenge' > '.test.executed'" }, "Bash"),
  ])("settles the exact native test operation once: %o", request => {
    expect(nativeQualificationPermission(request, files, "test-marker")).toEqual({
      outcome: { outcome: "selected", optionId: "allow_once" },
    });
  });
  it.each([
    permission({ file_path: `/srv/zeros/workspace/${files.challenge}`, offset: 1, limit: 100 }),
    permission({ file_path: `./${files.edited}`, content: "test-marker" }, "Write"),
    permission({ command: "cat '.test.challenge' > '.test.executed'", run_in_background: false, timeout: 30000, description: "Copy canary" }, "Bash"),
    permission({ command: "cat '.test.edited'" }, "Bash"),
    permission({ command: "cat '.test.executed'" }, "Bash"),
    { ...permission({ approvalKind: "command", approvalId: "native-id", command: "cat '.test.challenge'",
      cwd: "/srv/zeros/workspace", reason: undefined, networkApprovalContext: undefined,
      additionalPermissions: undefined, proposedExecpolicyAmendment: undefined,
      proposedNetworkPolicyAmendments: undefined, availableDecisions: ["accept", "cancel"] }, "Run: cat '.test.challenge'"),
      toolCall: { title: "Run: cat '.test.challenge'", kind: "execute", rawInput: { approvalKind: "command",
        command: "cat '.test.challenge'", cwd: "/srv/zeros/workspace", proposedExecpolicyAmendment: ["cat"],
        availableDecisions: ["accept", { acceptWithExecpolicyAmendment: { execpolicy_amendment: ["cat"] } }, "cancel"] } } },
    { ...permission({ filePaths: ["/srv/zeros/workspace/.test.edited"], reason: undefined, grantRoot: undefined }, "Apply file changes"),
      toolCall: { title: "Apply file changes", kind: "edit", rawInput: { filePaths: ["/srv/zeros/workspace/.test.edited"], reason: undefined, grantRoot: undefined } } },
  ])("accepts the native schema's safe options: %o", request => {
    expect(nativeQualificationPermission(request, files, "test-marker")).toEqual({
      outcome: { outcome: "selected", optionId: "allow_once" },
    });
  });
  it.each([
    permission({ file_path: "/etc/passwd" }),
    permission({ file_path: files.edited, content: "different" }, "Write"),
    permission({ command: "cat '.test.challenge' > '.test.executed'; env" }, "Bash"),
    permission({ command: "cat '.test.executed' > '.test.challenge'" }, "Bash"),
    permission({ command: "cat '.test.edited' > '.test.executed'" }, "Bash"),
    permission({ file_path: files.challenge, extraAuthority: true }),
    permission({ command: "cat '.test.challenge' > '.test.executed'", run_in_background: true }, "Bash"),
    permission({ file_path: files.challenge }, "Bash"),
    { ...permission({}), toolCall: { title: "Run: cat '.test.challenge'", kind: "execute", rawInput: {
      command: "cat '.test.challenge'", cwd: "/srv/zeros/workspace", additionalPermissions: { network: { enabled: true } } } } },
    { ...permission({}), toolCall: { title: "Run: cat '.test.challenge'", kind: "execute", rawInput: {
      command: "cat '.test.challenge'", cwd: "/srv/zeros/state" } } },
    { ...permission({}), toolCall: { title: "Apply file changes", kind: "edit", rawInput: {
      filePaths: ["/srv/zeros/workspace/.test.edited", "/etc/passwd"] } } },
    { ...permission({}), toolCall: { title: "Apply file changes", kind: "edit", rawInput: {
      filePaths: [files.edited], grantRoot: "/" } } },
    { ...permission({}), toolCall: { title: "Apply file changes", kind: "edit", rawInput: {} } },
    permission({ request: { operation: "read", path: files.challenge } }, "mcp__zeros_workspace__workspace"),
    { ...permission({ file_path: files.challenge }), options: [{ kind: "allow_always", optionId: "allow_always" }] },
  ])("cancels every unrequested action: %o", request => {
    expect(nativeQualificationPermission(request, files, "test-marker")).toEqual({ outcome: { outcome: "cancelled" } });
  });
});
