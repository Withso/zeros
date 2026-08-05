// ──────────────────────────────────────────────────────────
// Code textarea — compact CodeMirror command editor
// ──────────────────────────────────────────────────────────
//
// The Settings wrapper around the same CodeMirror + active-line + Shiki theme
// used by Files-tab Edit mode. It starts at one line, grows with the document,
// and becomes an inner scroller at 320px. An optional description sits in the
// same border1 container above the editor body.
// ──────────────────────────────────────────────────────────

import type { ReactNode } from "react";

import { CodeEditor } from "@/renderer/shell/workbench/tabs/code-editor";
import { cn } from "@/renderer/shared/ui/cn";

export interface CodeTextareaProps {
  /** The shell command being edited. */
  value: string;
  /** Fires on user edits with the complete command text. */
  onChange?: (value: string) => void;
  /** Optional context rendered above the numbered editor. */
  description?: ReactNode;
  /** Accessible name for the underlying contenteditable editor. */
  "aria-label": string;
  id?: string;
  className?: string;
}

export function CodeTextarea({
  value,
  description,
  onChange,
  id,
  className,
  "aria-label": ariaLabel,
}: CodeTextareaProps) {
  return (
    <div
      className={cn(
        "border-border1 overflow-hidden rounded-sm border bg-transparent",
        className,
      )}
    >
      {description != null && (
        <div className="border-border1 bg-bg1 text-fg2 border-b px-3 py-2 text-xs">
          {description}
        </div>
      )}
      <CodeEditor
        value={value}
        onChange={onChange}
        filePath="command.sh"
        compact
        ariaLabel={ariaLabel}
        editorId={id}
      />
    </div>
  );
}
