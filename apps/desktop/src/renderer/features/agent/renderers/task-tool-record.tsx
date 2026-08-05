// TaskToolRecord — Claude's durable task-list lifecycle.
//
// TaskCreate renders the task subject as the row description and preserves the
// longer task body in its detail. TaskUpdate translates the provider status
// into a useful lifecycle label while retaining the exact status and task id.

import { memo } from "react";
import { SquareCheckBig } from "lucide-react";

import { Card, CardContent } from "@/renderer/shared/ui/primitives/card";

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
    if (typeof value === "number" && Number.isFinite(value)) {
      return String(value);
    }
  }
  return null;
};

function taskLabel(message: AgentToolMessage, status: string | null): string {
  if (message.toolKind === "task_create") return "Task Created";
  if (status === "in_progress") return "Task Started";
  if (status === "completed") return "Task Completed";
  if (status === "deleted") return "Task Deleted";
  return "Task Updated";
}

function taskIdFromText(message: AgentToolMessage): string | null {
  const values: string[] = [];
  if (typeof message.rawOutput === "string") values.push(message.rawOutput);
  for (const block of message.content ?? []) {
    if (block.type !== "content" || block.content.type !== "text") continue;
    values.push(block.content.text);
  }
  for (const value of values) {
    const match = value.match(/\bTask\s+#?([\w.-]+)\b/i);
    if (match?.[1]) return match[1];
  }
  return null;
}

export const TaskToolRecord: Renderer<AgentToolMessage> = memo(
  function TaskToolRecord({ message, ctx }) {
    const input = asObject(message.rawInput);
    const output = asObject(message.rawOutput);
    const outputTask = asObject(output.task);
    const statusChange = asObject(output.statusChange);
    const status = text(input.status, statusChange.to);
    const subject = text(input.subject, outputTask.subject);
    const description = text(input.description);
    const taskId =
      text(input.taskId, output.taskId, outputTask.id) ??
      taskIdFromText(message);
    const target = subject ?? text(input.activeForm);
    const meta: EventMeta = {
      Icon: SquareCheckBig,
      label: taskLabel(message, status),
      ...(target ? { target } : {}),
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
              {subject ? (
                <strong className="text-fg1 font-medium">{subject}</strong>
              ) : null}
              {description ? (
                <span className="text-fg2 break-words">{description}</span>
              ) : null}
              {status ? <InfoRow label="Status" value={status} /> : null}
              <InfoRow label="Task ID" value={taskId ?? "Unknown"} mono />
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
