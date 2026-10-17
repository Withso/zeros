import { Terminal } from "lucide-react";
import type { LocalMessageNote } from "@zeros/protocol/agent-messages";
import { LocalLinkPill } from "./pill";
import { useLocalLinks } from "./context";
import { localLinkSpans } from "./model";

const LABELS = {
  done: "Chat finished",
  permission: "Permission requested",
  question: "Question asked",
} as const;

export function LocalNoteRow({ note }: { note: LocalMessageNote }) {
  const links = useLocalLinks();
  const detail = note.event === "done" ? note.status : note.cardTitle;
  const related = links.enabled && detail
    ? [...new Set(localLinkSpans(detail, links.scheme).map((span) => span.href))].filter((href) => href !== note.link)
    : [];
  return (
    <div
      data-local-note={note.event}
      className="text-fg3 -ml-2 flex min-w-0 flex-wrap items-center gap-2 px-2 py-1 text-xs"
    >
      <Terminal className="text-fg2 size-3 shrink-0" aria-hidden="true" />
      <span className="text-fg1 text-sm">{LABELS[note.event]}</span>
      <LocalLinkPill href={note.link} fallback={note} />
      {related.map((href) => <LocalLinkPill key={href} href={href} />)}
      {detail && (
        <span data-tool-preview="" className="text-fg3 min-w-0 truncate">
          {detail}
        </span>
      )}
    </div>
  );
}
