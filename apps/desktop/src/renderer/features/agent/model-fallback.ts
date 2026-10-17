import {
  modelFallbackText,
  type AgentMessage,
  type AgentTextMessage,
} from "@zeros/protocol/agent-messages";
import type { ModelFallbackInfo } from "@zeros/protocol/agent-events";
import type { ChatEffort } from "../../state/store";
import { displayNameForModelValue, effortLabel } from "./model-catalog";

export function fallbackDisplayText(info: ModelFallbackInfo): string {
  // Use the user's concise narration order (Sol 5.6) while the model picker
  // retains its shared catalog label (GPT-5.6 Sol) and exact native value.
  const prose = (model: string) => {
    const label = displayNameForModelValue(info.provider, model);
    return info.provider === "codex"
      ? label.replace(/^GPT-([\d.]+)\s+(.+)$/, "$2 $1")
      : label;
  };
  return modelFallbackText(
    info,
    prose(info.toModel),
    info.fromModel ? prose(info.fromModel) : null,
    (effort) => effortLabel(info.provider, effort as ChatEffort),
  );
}

/** Old persisted model_switch tool rows get the same prose presentation. They
 * never drive live selection: only a newly accepted engine update may do so. */
export function fallbackProse(message: AgentMessage): AgentTextMessage | null {
  if (message.kind === "text")
    return message.modelFallback
      ? { ...message, text: fallbackDisplayText(message.modelFallback) }
      : null;
  if (message.kind !== "tool" || message.toolKind !== "model_switch")
    return null;
  const input = message.rawInput as Record<string, unknown> | undefined;
  if (
    !input ||
    typeof input.toModel !== "string" ||
    !input.toModel ||
    input.toModel === "<synthetic>"
  )
    return null;
  const provider =
    input.reason === "highRiskCyberActivity" || input.toModel.startsWith("gpt-")
      ? "codex"
      : "claude";
  const reason =
    input.reason === "highRiskCyberActivity"
      ? "cybersecurity"
      : input.reason === "refusal"
        ? "refusal"
        : input.reason === "overloaded"
          ? "overloaded"
          : "unknown";
  const info: ModelFallbackInfo = {
    provider,
    fromModel: typeof input.fromModel === "string" ? input.fromModel : null,
    toModel: input.toModel,
    reason,
    scope:
      message.parentToolId || input.scope === "local" || reason === "overloaded"
        ? "local"
        : "session",
  };
  return {
    id: message.id,
    kind: "text",
    role: "agent",
    phase: "commentary",
    text: fallbackDisplayText(info),
    createdAt: message.createdAt,
    parentToolId: message.parentToolId,
    modelFallback: info,
  };
}
