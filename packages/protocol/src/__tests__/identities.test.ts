import { describe, expect, it } from "vitest";

import {
  coerceProviderBinding,
  legacyProviderBinding,
  providerBindingForResume,
  sameProviderBinding,
  validateIdentityTransition,
} from "../identities";

describe("Zeros identity model", () => {
  it("keeps workspace, conversation, execution, and provider identities distinct", () => {
    expect(
      validateIdentityTransition(
        {
          workspaceId: "ws-1",
          conversationId: "chat-1",
          executionId: "exec-1",
          providerBinding: {
            version: 1,
            providerId: "codex",
            kind: "native",
            resumeId: "thread-1",
            scopeId: "root-session-1",
          },
        },
        {
          workspaceId: "ws-1",
          conversationId: "chat-1",
          executionId: "exec-2",
          providerBinding: {
            version: 1,
            providerId: "codex",
            kind: "native",
            resumeId: "thread-1",
            scopeId: "root-session-1",
          },
        },
      ),
    ).toEqual([]);

    expect(
      validateIdentityTransition(
        {
          workspaceId: "ws-1",
          conversationId: "chat-1",
          executionId: "exec-1",
          providerBinding: null,
        },
        {
          workspaceId: "ws-2",
          conversationId: "chat-2",
          executionId: "exec-2",
          providerBinding: null,
        },
      ),
    ).toEqual([
      "workspace identity changed inside one conversation lifecycle",
      "conversation identity changed inside one conversation lifecycle",
    ]);
  });

  it("coerces only versioned, non-empty, provider-owned bindings", () => {
    expect(
      coerceProviderBinding({
        version: 1,
        providerId: "codex",
        kind: "native",
        resumeId: "thread-1",
        scopeId: "session-tree-1",
        legacySessionId: "old-live-id",
      }),
    ).toEqual({
      version: 1,
      providerId: "codex",
      kind: "native",
      resumeId: "thread-1",
      scopeId: "session-tree-1",
      legacySessionId: "old-live-id",
    });
    expect(
      coerceProviderBinding({
        version: 2,
        providerId: "codex",
        kind: "native",
        resumeId: "thread-1",
      }),
    ).toBeNull();
    expect(
      coerceProviderBinding({
        version: 1,
        providerId: "",
        kind: "native",
        resumeId: "thread-1",
      }),
    ).toBeNull();
  });

  it("marks old opaque session locators as legacy except Cursor's native agent id", () => {
    expect(legacyProviderBinding("cursor", "cursor-agent-1")).toEqual({
      version: 1,
      providerId: "cursor",
      kind: "native",
      resumeId: "cursor-agent-1",
    });
    expect(legacyProviderBinding("claude", "zeros-session-dir-1")).toEqual({
      version: 1,
      providerId: "claude",
      kind: "legacy",
      resumeId: "zeros-session-dir-1",
      legacySessionId: "zeros-session-dir-1",
    });
  });

  it("preserves a provider's native binding and compares all identity fields", () => {
    const binding = providerBindingForResume("claude", "claude-session-1", {
      legacySessionId: "old-zeros-execution",
    });
    expect(binding).toEqual({
      version: 1,
      providerId: "claude",
      kind: "native",
      resumeId: "claude-session-1",
      legacySessionId: "old-zeros-execution",
    });
    expect(sameProviderBinding(binding, { ...binding })).toBe(true);
    expect(
      sameProviderBinding(binding, { ...binding, resumeId: "different" }),
    ).toBe(false);
  });
});
