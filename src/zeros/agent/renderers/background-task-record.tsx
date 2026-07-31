// BackgroundTaskRecord — durable history for one settled/live lifecycle.
//
// Collapsed: Activity icon · "Background Task" (or the initial "Task
// Started") · task-name pill. Expanded: the small information card. There is
// intentionally no Outcome heading, success tick, status chip, View output, or
// Inspect action; the provider result is already available in the detail.

import { memo } from "react";
import { Activity } from "lucide-react";

import { formatElapsed } from "@/loaders";
import { Card, CardContent } from "@/zeros/ui/primitives/card";

import type { AgentToolMessage } from "../use-agent-session";
import { EventRow, type EventMeta } from "./event-row";
import type { Renderer } from "./types";

const asObject = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const text = (...values: unknown[]): string | null => {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) return value;
  }
  return null;
};

export const BackgroundTaskRecord: Renderer<AgentToolMessage> = memo(
  function BackgroundTaskRecord({ message, ctx }) {
    const input = asObject(message.rawInput);
    const output = asObject(message.rawOutput);
    const name =
      text(input.name, input.description, input.command, input.prompt) ??
      `Task ${text(input.taskId) ?? ""}`.trim();
    const command = text(input.command);
    const taskId = text(input.taskId);
    const summary = text(output.summary, output.error);
    const providerStatus = text(output.status);
    const outputFile = text(output.outputFile);
    const durationMs =
      typeof output.durationMs === "number" ? output.durationMs : null;
    const meta: EventMeta = {
      Icon: Activity,
      label:
        message.title === "Task Started" ? "Task Started" : "Background Task",
      target: name,
      expandable: true,
    };

    return (
      <EventRow
        message={message}
        ctx={ctx}
        meta={meta}
        detail={
          <Card>
            <CardContent className="flex flex-col gap-2 p-3 text-sm">
              <strong className="text-fg1 font-medium">{name}</strong>
              {command ? (
                <InfoRow label="Command" value={command} mono />
              ) : null}
              <InfoRow label="Task ID" value={taskId ?? "Unknown"} mono />
              {providerStatus ? (
                <InfoRow label="Status" value={providerStatus} />
              ) : null}
              {summary ? <InfoRow label="Result" value={summary} /> : null}
              {durationMs !== null ? (
                <InfoRow label="Duration" value={formatElapsed(durationMs)} />
              ) : null}
              {outputFile ? (
                <InfoRow label="Output file" value={outputFile} mono />
              ) : null}
            </CardContent>
          </Card>
        }
      />
    );
  },
);

function InfoRow({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="grid min-w-0 grid-cols-[88px_minmax(0,1fr)] gap-2">
      <span className="text-fg3">{label}</span>
      <span
        className={
          mono
            ? "text-fg1 font-mono text-xs break-words"
            : "text-fg1 break-words"
        }
      >
        {value}
      </span>
    </div>
  );
}
