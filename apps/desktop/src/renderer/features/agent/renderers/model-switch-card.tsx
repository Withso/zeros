// Compatibility renderer for already-persisted model_switch records.
// New provider fallbacks arrive as ordinary commentary.
import { memo } from "react";
import type { AgentToolMessage } from "../use-agent-session";
import type { Renderer } from "./types";
import { fallbackProse } from "../model-fallback";
import { TextMessage } from "./text-message";

export const ModelSwitchRecordCard: Renderer<AgentToolMessage> = memo(
  function ModelSwitchRecordCard({ message, ctx }) {
    const prose = fallbackProse(message);
    return prose ? <TextMessage message={prose} ctx={ctx} /> : null;
  },
);
