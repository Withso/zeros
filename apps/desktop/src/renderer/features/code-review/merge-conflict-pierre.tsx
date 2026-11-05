// Merge conflicts in place on Pierre surfaces (Changes cards and read-only
// source). Rows are marked by line inside each item's shadow root; the accept
// row is an ordinary line annotation above a block's opening marker. The
// palette matches the Files editor's (merge-conflict-blocks.ts).

import type {
  ConflictChoice,
  MergeConflictParseResult,
} from "@zeros/protocol/merge-conflicts";
import { cn } from "@/renderer/shared/ui/cn";
import { MessageRow } from "@/renderer/shared/ui/primitives/message-row";
import { Button } from "@/renderer/shared/ui/primitives";
import {
  CONFLICT_CHOICES,
  actionableConflicts,
  conflictMarkerNotice,
  conflictRowKind,
  type ConflictRowKind,
} from "./merge-conflict-rows";

/** Each row kind's tint (zeros-tokens.css); translucent over the surface. */
const ROW_TOKEN: Record<ConflictRowKind, string> = {
  "current-marker": "--conflict-current-band",
  current: "--conflict-current",
  base: "--conflict-neutral",
  separator: "--conflict-neutral",
  incoming: "--conflict-incoming",
  "incoming-marker": "--conflict-incoming-band",
};

const LABEL: Partial<Record<ConflictRowKind, string>> = {
  "current-marker": "(Current change)",
  "incoming-marker": "(Incoming change)",
};

/** Per-file rules keyed by line. Unlayered, so they win over Pierre's layered
 * row colours while hover and selection still mix over the tint. */
export function conflictRowsStyle(parsed: MergeConflictParseResult): string {
  const lines = new Map<ConflictRowKind, number[]>();
  for (const conflict of actionableConflicts(parsed))
    for (let line = conflict.startLine; line <= conflict.endLine; line++) {
      const kind = conflictRowKind(conflict, line);
      lines.set(kind, [...(lines.get(kind) ?? []), line]);
    }
  const rules: string[] = [];
  for (const [kind, numbers] of lines) {
    const rows = numbers
      .map((n) => `[data-line="${n}"],[data-column-number="${n}"]`)
      .join(",");
    rules.push(`${rows}{--diffs-computed-decoration-bg:var(${ROW_TOKEN[kind]});}`);
    const label = LABEL[kind];
    if (label)
      rules.push(
        `${numbers.map((n) => `[data-line="${n}"]::after`).join(",")}{content:${JSON.stringify(label)};margin-left:8px;color:var(--fg3);font-family:var(--font-sans);pointer-events:none;}`,
      );
  }
  return rules.join("\n");
}

const STYLE_ATTRIBUTE = "data-zeros-conflict-rows";

/** Keep one host's conflict rules in step with the file it now renders.
 * Hosts are reused across items, so a host showing anything else is cleared. */
export function syncConflictRowsStyle(
  node: HTMLElement,
  css: string | null | undefined,
): void {
  const root = node.shadowRoot;
  if (!root) return;
  let style = root.querySelector<HTMLStyleElement>(`style[${STYLE_ATTRIBUTE}]`);
  if (!css) {
    style?.remove();
    return;
  }
  if (!style) {
    style = document.createElement("style");
    style.setAttribute(STYLE_ATTRIBUTE, "");
    root.append(style);
  }
  if (style.textContent !== css) style.textContent = css;
}

export type ConflictAnnotation =
  | { kind: "actions"; index: number; count: number }
  | { kind: "notice"; message: string; tone: "error" | "neutral" };

/** The accept row above each block, or one notice above the first line when
 * the markers cannot be paired or the view cannot write. */
export function conflictAnnotations<Payload>(
  parsed: MergeConflictParseResult,
  options: {
    canAccept: boolean;
    readOnlyNotice?: string;
    payload: (annotation: ConflictAnnotation, key: string) => Payload;
  },
): Array<{ lineNumber: number; metadata: Payload }> {
  const notice = conflictMarkerNotice(parsed);
  if (notice)
    return [
      {
        lineNumber: 0,
        metadata: options.payload(
          { kind: "notice", message: notice, tone: "error" },
          "conflict-notice",
        ),
      },
    ];
  const conflicts = actionableConflicts(parsed);
  if (!conflicts.length) return [];
  if (!options.canAccept)
    return options.readOnlyNotice
      ? [
          {
            lineNumber: 0,
            metadata: options.payload(
              { kind: "notice", message: options.readOnlyNotice, tone: "neutral" },
              "conflict-notice",
            ),
          },
        ]
      : [];
  return conflicts.map((conflict, index) => ({
    lineNumber: conflict.startLine - 1,
    metadata: options.payload(
      { kind: "actions", index, count: conflicts.length },
      `conflict-actions:${conflict.start}`,
    ),
  }));
}

const ACCEPT_TONE: Record<ConflictChoice, string> = {
  current:
    "bg-green-secondary text-green-secondary-fg hover:bg-green-secondary-hover",
  incoming:
    "bg-blue-secondary text-blue-secondary-fg hover:bg-blue-secondary-hover",
  both: "bg-neutral-secondary text-neutral-secondary-fg hover:bg-neutral-secondary-hover",
};

export function ConflictAnnotationView({
  annotation,
  disabled,
  onAccept,
}: {
  annotation: ConflictAnnotation;
  disabled?: boolean;
  onAccept: (index: number, choice: ConflictChoice) => void;
}) {
  if (annotation.kind === "notice")
    return (
      <MessageRow tone={annotation.tone} role="status" className="font-sans">
        {annotation.message}
      </MessageRow>
    );
  return (
    <div
      role="group"
      aria-label={`Conflict ${annotation.index + 1} of ${annotation.count}`}
      className="bg-conflict-neutral flex items-center gap-1.5 py-1 pr-1.5 pl-1 font-sans"
    >
      {CONFLICT_CHOICES.map(({ choice, label }) => (
        <Button
          key={choice}
          disabled={disabled}
          onClick={() => onAccept(annotation.index, choice)}
          className={cn(
            "h-5 rounded-sm border-transparent px-2 py-0 text-3xxs leading-4 hover:border-transparent",
            ACCEPT_TONE[choice],
          )}
        >
          {label}
        </Button>
      ))}
    </div>
  );
}
