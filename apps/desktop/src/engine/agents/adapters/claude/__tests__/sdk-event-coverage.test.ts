import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { ClaudeStreamTranslator, mapClaudeTerminalReason } from "../translator";
import type { SessionNotification } from "../../../types";

type EventKey<T> = T extends { type: infer Kind extends string }
  ? T extends { subtype: infer Subtype extends string }
    ? `${Kind}/${Subtype}`
    : Kind
  : never;
type Disposition = "handled" | "intentionally ignored" | "unsupported";

// An SDK upgrade must classify each new discriminator AND each new public
// union member (including aliases such as SDKUserMessageReplay). Explanations,
// field-level limitations and regression entry points live in the linked doc.
const coverage = {
  assistant: ["handled", "SDKAssistantMessage"],
  user: ["handled", "SDKUserMessage", "SDKUserMessageReplay"],
  "result/success": ["handled", "SDKResultMessage"],
  "result/error_during_execution": ["handled", "SDKResultMessage"],
  "result/error_max_turns": ["handled", "SDKResultMessage"],
  "result/error_max_budget_usd": ["handled", "SDKResultMessage"],
  "result/error_max_structured_output_retries": ["handled", "SDKResultMessage"],
  "system/init": ["handled", "SDKSystemMessage"],
  stream_event: ["handled", "SDKPartialAssistantMessage"],
  "system/compact_boundary": ["handled", "SDKCompactBoundaryMessage"],
  "system/status": ["handled", "SDKStatusMessage"],
  "system/api_retry": ["handled", "SDKAPIRetryMessage"],
  "system/control_request_progress": [
    "unsupported",
    "SDKControlRequestProgressMessage",
  ],
  "system/model_refusal_fallback": [
    "handled",
    "SDKModelRefusalFallbackMessage",
  ],
  "system/model_refusal_no_fallback": [
    "handled",
    "SDKModelRefusalNoFallbackMessage",
  ],
  "system/local_command_output": ["handled", "SDKLocalCommandOutputMessage"],
  "system/hook_started": ["intentionally ignored", "SDKHookStartedMessage"],
  "system/hook_progress": ["intentionally ignored", "SDKHookProgressMessage"],
  "system/hook_response": ["handled", "SDKHookResponseMessage"],
  "system/plugin_install": ["handled", "SDKPluginInstallMessage"],
  tool_progress: ["handled", "SDKToolProgressMessage"],
  auth_status: ["handled", "SDKAuthStatusMessage"],
  "system/task_notification": ["handled", "SDKTaskNotificationMessage"],
  "system/task_started": ["handled", "SDKTaskStartedMessage"],
  "system/task_updated": ["handled", "SDKTaskUpdatedMessage"],
  "system/task_progress": ["handled", "SDKTaskProgressMessage"],
  "system/background_tasks_changed": [
    "handled",
    "SDKBackgroundTasksChangedMessage",
  ],
  "system/thinking_tokens": ["handled", "SDKThinkingTokensMessage"],
  "system/session_state_changed": ["handled", "SDKSessionStateChangedMessage"],
  "system/worker_shutting_down": [
    "intentionally ignored",
    "SDKWorkerShuttingDownMessage",
  ],
  "system/commands_changed": ["handled", "SDKCommandsChangedMessage"],
  "system/notification": ["handled", "SDKNotificationMessage"],
  "system/files_persisted": ["handled", "SDKFilesPersistedEvent"],
  tool_use_summary: ["intentionally ignored", "SDKToolUseSummaryMessage"],
  "system/memory_recall": ["intentionally ignored", "SDKMemoryRecallMessage"],
  rate_limit_event: ["handled", "SDKRateLimitEvent"],
  "system/elicitation_complete": ["handled", "SDKElicitationCompleteMessage"],
  "system/permission_denied": ["handled", "SDKPermissionDeniedMessage"],
  prompt_suggestion: ["unsupported", "SDKPromptSuggestionMessage"],
  "system/mirror_error": ["handled", "SDKMirrorErrorMessage"],
  "system/informational": ["handled", "SDKInformationalMessage"],
  conversation_reset: ["handled", "SDKConversationResetMessage"],
} as const satisfies Record<
  EventKey<SDKMessage>,
  readonly [Disposition, ...string[]]
>;

describe("installed Claude SDK event inventory", () => {
  it("classifies every public SDKMessage alias and documents every discriminator", () => {
    const require = createRequire(import.meta.url);
    const declarations = readFileSync(
      join(
        dirname(require.resolve("@anthropic-ai/claude-agent-sdk")),
        "sdk.d.ts",
      ),
      "utf8",
    );
    const source = ts.createSourceFile(
      "sdk.d.ts",
      declarations,
      ts.ScriptTarget.Latest,
      true,
    );
    const union = source.statements.find(
      (s): s is ts.TypeAliasDeclaration =>
        ts.isTypeAliasDeclaration(s) && s.name.text === "SDKMessage",
    )!;
    expect(ts.isUnionTypeNode(union.type)).toBe(true);
    const installed = (union.type as ts.UnionTypeNode).types
      .map((t) => t.getText(source))
      .sort();
    const classified = [
      ...new Set(Object.values(coverage).flatMap(([, ...aliases]) => aliases)),
    ].sort();
    expect(classified).toEqual(installed);
    const doc = readFileSync(
      join(process.cwd(), "docs/claude-event-coverage.md"),
      "utf8",
    );
    for (const [event, [disposition]] of Object.entries(coverage)) {
      expect(doc).toContain(`| \`${event}\` | ${disposition} |`);
    }
    for (const name of ["HookEvent", "TerminalReason"]) {
      const alias = source.statements.find(
        (s): s is ts.TypeAliasDeclaration =>
          ts.isTypeAliasDeclaration(s) && s.name.text === name,
      )!;
      expect(ts.isUnionTypeNode(alias.type)).toBe(true);
      for (const variant of (alias.type as ts.UnionTypeNode).types) {
        expect(
          ts.isLiteralTypeNode(variant) && ts.isStringLiteral(variant.literal),
        ).toBe(true);
        const value = (
          (variant as ts.LiteralTypeNode).literal as ts.StringLiteral
        ).text;
        if (name === "HookEvent") expect(doc).toContain(`\`${value}\``);
        else
          expect(
            mapClaudeTerminalReason(value),
            `Unmapped installed terminal reason: ${value}`,
          ).not.toBeNull();
      }
    }
  });

  it.each(
    Object.entries(coverage).filter(
      ([, [disposition]]) => disposition !== "handled",
    ),
  )("%s cannot add transcript content, wake work, or settle a turn", (key) => {
    const events: SessionNotification[] = [];
    const t = new ClaudeStreamTranslator({
      sessionId: "session",
      emit: (event) => events.push(event),
    });
    const [type, subtype] = key.split("/");
    const frame = {
      type,
      subtype,
      uuid: "frame",
      content: "private fixture",
      stdout: "private fixture",
      summary: "private fixture",
      suggestion: "private fixture",
      reason: "host_exit",
    };
    t.feed(frame);
    t.feed(frame);
    expect(events).toEqual([]);
    expect(t.sawResult).toBe(false);
    expect(t.hasProcessWork).toBe(false);
  });
});
