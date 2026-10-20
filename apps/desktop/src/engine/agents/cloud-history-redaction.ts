import { canonicalCloudLocalCommandHistoryJson as canonical,
  type CloudLocalCommandHistoryRecord } from "@zeros/protocol/cloud-local-mirror";
import type { CloudCustomizationRedactor } from "./cloud-customization-redaction";

export type CloudHistoryRedactor = (value: unknown, kind: CloudLocalCommandHistoryRecord["entityKind"]) => unknown;
type ObjectValue = Record<string, unknown>;
type Filter = (value: unknown) => unknown;

function refuse(): never { throw new Error("Cloud history redaction refused"); }
function object(value: unknown): ObjectValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) refuse();
  return value as ObjectValue;
}
// Only the named structural scalar at its declared path is exempt. A nested
// object in an identity slot is malformed, not a way to bypass filtering.
function scalar(value: unknown): unknown {
  if (value !== null && typeof value === "object") refuse();
  return value;
}
const array = (filter: Filter): Filter => value => {
  if (!Array.isArray(value)) refuse();
  return value.map(filter);
};
const nullable = (filter: Filter): Filter => value => value === null ? null : filter(value);

/** Filter the original execution's canonical history by record kind. Unknown
 * fields remain content, never implicit identity exemptions. Unknown variants
 * and malformed JSON refuse capture; there is no unfiltered fallback. This
 * grants no authority: the capture independently checks identities and heads. */
export function pinCloudHistoryContentRedactor(redactor: CloudCustomizationRedactor): CloudHistoryRedactor {
  const content: Filter = value => redactor.value(value, "terminal");
  const fields = (value: unknown, preserved: readonly string[], nested: Record<string, Filter> = {}): ObjectValue =>
    Object.fromEntries(Object.entries(object(value)).map(([key, entry]) => [key,
      Object.hasOwn(nested, key) ? nested[key]!(entry) : preserved.includes(key) ? scalar(entry) : content(entry)]));
  const shape = (preserved: readonly string[], nested?: Record<string, Filter>): Filter => value => fields(value, preserved, nested);
  const json = (filter: Filter): Filter => value => {
    if (typeof value !== "string") refuse();
    const parsed: unknown = JSON.parse(value);
    // The outer record bounds the encoded string's bytes, not its decoded
    // depth. Bound the decoded JSON before any recursive content scrubber.
    canonical(parsed);
    return canonical(filter(parsed));
  };
  const annotations = shape(["lastModified", "priority"], { audience: array(scalar) });
  const resource = shape(["mimeType", "size"], { annotations });
  const block: Filter = value => {
    switch (object(value).type) {
      case "text": case "image": case "audio": case "resource_link":
        return fields(value, ["type", "mimeType", "size"], { annotations });
      case "resource": return fields(value, ["type"], { annotations, resource });
      default: return refuse();
    }
  };
  const toolContent: Filter = value => {
    switch (object(value).type) {
      case "content": return fields(value, ["type"], { content: block });
      case "diff": return fields(value, ["type"]);
      case "terminal": return fields(value, ["type", "terminalId"]);
      default: return refuse();
    }
  };
  const toolFields = {
    content: nullable(array(toolContent)), locations: nullable(array(shape(["line"]))), resourceLinks: array(block),
  };
  const tool = shape(["toolCallId", "nativeToolCallId", "kind", "status", "mergeKey", "parentToolId", "at"], toolFields);
  const option = shape(["id", "optionId", "kind", "exclusive"], { externalAction: shape(["kind"]) });
  const answer = shape(["questionId"], { selectedOptionIds: array(scalar) });
  const question = shape(["id", "inputType", "multiSelect", "allowOther", "allowEmptyFreeText", "preserveFreeText",
    "secret", "presentation", "approvalKind"], { options: array(option), defaultOptionIds: array(scalar), answer });
  const attachment = shape(["kind", "delivery", "size", "mimeType", "attachmentId"]);
  const segment: Filter = value => {
    switch (object(value).type) {
      case "text": return fields(value, ["type"]);
      case "mention": return fields(value, ["type", "kind"]);
      case "attachment": return fields(value, ["type", "kind", "delivery", "size", "mimeType", "attachmentId"]);
      default: return refuse();
    }
  };
  const chatRef = shape(["chatId", "agentId", "link", "event", "status", "cardId", "cardKind"]);
  const modelSettings = shape(["effort", "fast"]);
  const modelFallback = shape(["provider", "fromModel", "toModel", "scope", "reason"], {
    fromSettings: modelSettings, toSettings: modelSettings,
  });
  const message: Filter = value => {
    const common = ["id", "kind", "createdAt", "updatedAt"];
    switch (object(value).kind) {
      case "text": return fields(value, [...common, "role", "messageId", "phase", "parentToolId", "redacted", "durationMs",
        "retracted", "retractedToolCallId", "summaryBoundary", "resumeBoundary", "queued", "queuedDelivery",
        "queuedPresentation", "queuedEditable", "steeredTurnId", "autoAction"], {
        modelFallback, authRecovery: shape([]), recoveryFailure: shape(["kind"]),
        attachments: array(attachment), segments: array(segment), localFrom: chatRef, localNote: chatRef,
      });
      case "tool": return fields(value, [...common, "toolCallId", "nativeToolCallId", "toolKind", "status", "mergeKey",
        "parentToolId", "settledAt", "resultRetracted", "resultRevision"], toolFields);
      case "thinking": return fields(value, [...common, "messageId", "durationMs", "redacted"]);
      case "question": return fields(value, [...common, "source", "toolCallId", "questionId", "nativeRequestId", "blocking"],
        { questions: array(question) });
      case "mode_switch": return fields(value, [...common, "axis", "from", "to", "source", "requiresApproval"]);
      case "subagent": return fields(value, [...common, "marker", "subagentId", "parentToolId"]);
      case "error_notice": return fields(value, [...common, "parentToolId", "severity", "failureKind", "recoverable", "code"],
        { turnFailure: shape(["turnId", "kind"]) });
      default: return refuse();
    }
  };
  const permission = shape(["sessionId", "executionId", "nativeRequestId", "autoResolution", "useOptionNames",
    "allowLocalPolicies", "requiresExplicitApproval"], { toolCall: tool, options: array(option) });
  const questionRequest = shape(["sessionId", "executionId", "questionId", "nativeRequestId", "toolCallId", "source",
    "blocking", "allowDecline", "expiresAt"], { questions: array(question) });
  const control: Filter = value => {
    const frame = object(value), preserved = ["id", "timestamp", "source", "agentId", "chatId", "type", "permissionId",
      "questionId", "sessionId", "executionId"];
    const nested: Record<string, Filter> = { cloudStream: shape(["streamId", "sequence", "requiresSnapshot"]) };
    switch (frame.type) {
      case "AGENT_PERMISSION_REQUEST": nested.request = permission; break;
      case "AGENT_PERMISSION_SETTLED": break;
      case "AGENT_QUESTION_REQUEST": nested.request = questionRequest; break;
      case "AGENT_QUESTION_SETTLED": nested.outcome = shape(["outcome"], { answers: array(answer) }); break;
      default: return refuse();
    }
    return fields(value, preserved, nested);
  };
  const usage: Filter = shape(["accountingVersion", "revision", "costKind", "inputTokens", "outputTokens", "cacheReadTokens",
    "cacheWriteTokens", "reasoningTokens", "totalCostUsd"], {
    perModel: array(shape(["model", "inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "costUsd"])),
    _sources: array(shape(["id"], { usage: value => usage(value) })),
  });
  const chat = shape(["id", "folder", "agentId", "model", "effort", "permissionMode", "composerMode", "composerModeRevision",
    "lastModeId", "prePlanModeId", "sessionId", "sourceChatId", "kind", "fast", "pinned", "archived", "createdAt", "updatedAt"], {
    providerBinding: nullable(shape(["version", "providerId", "kind", "resumeId", "scopeId", "legacySessionId"])),
    providerMetadata: nullable(shape(["version"], { git: shape(["sha"]) })),
  });
  const turn = shape(["chat_id", "turn_id", "workspace_id", "folder", "agent_id", "ord", "started_at", "ended_at",
    "status", "stop_reason", "pre_snapshot", "post_snapshot"], {
    files: nullable(json(array(shape(["status", "additions", "deletions"])))), usage: nullable(json(usage)),
  });
  return (value, kind) => {
    canonical(value);
    if (object(value).version !== 1) refuse();
    switch (kind) {
      case "chat": return fields(value, ["version"], { chat });
      case "message": return fields(value, ["version", "chatId", "msgId", "ord", "kind", "createdAt"], { payload: json(message) });
      case "turn": return fields(value, ["version"], { row: turn });
      case "control": return fields(value, ["version", "eventSequence", "executionId", "turnId", "commandId"], { frame: control });
      default: return refuse();
    }
  };
}
