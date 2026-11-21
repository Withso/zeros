// The live turn's loader line names its current tool call with the same
// label as the call's row: name, then its description or file tag.

import { useCallback, useSyncExternalStore } from "react";
import { metaForEvent } from "./renderers/event-meta";
import { FileTag } from "./renderers/file-tag";
import { localCliPresentation } from "./renderers/local-cli-presentation";
import { TOOL_DESCRIPTION_FIT, ToolName, ToolPreview } from "./renderers/tool-label";
import { useLocalLinks } from "./local-links/context";
import { isTransientConnectionNotice } from "./transcript-notices";
import { cn } from "@/renderer/shared/ui/cn";
import type { LoaderLine } from "./working-group";
import type { LiveAgentTextSource } from "./local-live-text";
import type { AgentMessage } from "./use-agent-session";

type LoaderLineLabelSubject = Extract<LoaderLine, { kind: "tool" | "thinking" | "status" }>;

export function loaderLineKey(subject: LoaderLineLabelSubject): string {
  return `${subject.kind}:${subject.event.id}`;
}

const noSubscription = () => () => {};

/** A Local thought streams into its row without re-rendering the chat. The
 * line follows it only to learn when its opening line settles: the selected
 * value is the static description, so it re-renders once, not per delta. */
export function useThoughtPreview(event: AgentMessage | undefined, streaming: boolean, source: LiveAgentTextSource | undefined): string | undefined {
  const read = useCallback(() => {
    if (event?.kind !== "text") return undefined;
    const thought = source ? source.read(event) : event;
    return metaForEvent(thought, { streaming }).target;
  }, [event, source, streaming]);
  return useSyncExternalStore(source ? source.subscribe : noSubscription, read, read);
}

/** Always the normal tone: the group header's red icon reports a failure,
 * so the line never says "Error". A thought shows its name and, once its
 * opening line is known, that line as a static description (like its row);
 * an empty or redacted one shows the name alone. */
export function LoaderLineLabel({ subject, source }: {
  subject: LoaderLineLabelSubject;
  source?: LiveAgentTextSource;
}) {
  const links = useLocalLinks();
  const streaming = subject.kind === "thinking" && subject.streaming;
  const preview = useThoughtPreview(subject.kind === "thinking" ? subject.event : undefined, streaming, streaming ? source : undefined);
  if (subject.kind === "thinking") {
    return (
      <>
        <ToolName label="Thinking" capped={!!preview} className="text-fg1" />
        {preview ? <ToolPreview>{preview}</ToolPreview> : null}
      </>
    );
  }
  const meta = metaForEvent(subject.event);
  if (subject.kind === "status") {
    const event = subject.event;
    const text = isTransientConnectionNotice(event) ? meta.label
      : event.kind === "error_notice" ? event.message
        : event.kind === "text" ? event.text.trim() : meta.label;
    return <span className="text-fg2 min-w-0 truncate text-reading leading-5">{text}</span>;
  }
  const localCli = links.enabled ? localCliPresentation(subject.event, links.scheme) : null;
  const label = localCli?.label ?? meta.label;
  const target = localCli ? localCli.preview : meta.target;
  const file = !localCli && meta.targetFile && target;
  return (
    <>
      <ToolName label={label} capped={!!target} className="text-fg1" />
      {file ? (
        // A label here, not a control: the row's own tag opens the file.
        <FileTag
          name={meta.filePath ?? target}
          kind={meta.targetKind}
          tabIndex={-1}
          aria-hidden="true"
          className={cn(TOOL_DESCRIPTION_FIT, "pointer-events-none")}
        />
      ) : target ? (
        <ToolPreview mono={!!localCli}>{target}</ToolPreview>
      ) : null}
    </>
  );
}
