import { useEffect, useId, useState } from "react";
import { Ellipsis, Save, Undo2 } from "lucide-react";
import {
  Button,
  Kbd,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Separator,
  Switch,
} from "@/renderer/shared/ui/primitives";
import { IconButton } from "@/renderer/shared/ui/primitives/icon-button";
import { cn } from "@/renderer/shared/ui/cn";
import {
  setFileEditorPreferences,
  useFileEditorPreferences,
} from "./editor-preferences";

export interface FileEditorControls {
  dirty: boolean;
  saving: boolean;
  canSave: boolean;
  canDiscard: boolean;
  save: () => void;
  discard: () => void;
  /** Conflict blocks still in the draft, for the header navigator. */
  conflicts: {
    count: number;
    /** 1-based block at or after the caret. */
    shown: number;
    previous: () => void;
    next: () => void;
  } | null;
}

export function FileEditorOptions({
  active,
  controls,
  canDiff,
  diffWaiting = false,
  onDiffViewChange,
}: {
  active: boolean;
  controls: FileEditorControls | null;
  canDiff: boolean;
  /** Git still lists the file as conflicted, so Diff view waits. */
  diffWaiting?: boolean;
  onDiffViewChange: () => void;
}) {
  const [open, setOpen] = useState(false);
  const preferences = useFileEditorPreferences();
  const id = useId();
  useEffect(() => {
    if (!active) setOpen(false);
  }, [active]);
  return (
    <Popover open={active && open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <IconButton label="File options" size="standard" disabled={!active}>
          <Ellipsis />
        </IconButton>
      </PopoverTrigger>
      {/* The menu recipe: a 4px inset and 28px rows with 8px corners, the
          actions and the switches on one left edge. */}
      <PopoverContent
        align="end"
        className="w-60 p-1"
        aria-label="File options"
      >
        <Button
          variant="ghost"
          className="h-auto min-h-7 w-full justify-start gap-2 rounded-lg px-2 font-normal"
          disabled={!controls?.canSave}
          onClick={() => {
            controls?.save();
            setOpen(false);
          }}
        >
          <Save className="size-3.5" />
          {controls?.saving ? "Saving…" : "Save file"}
          <Kbd className="ml-auto">⌘S</Kbd>
        </Button>
        <Button
          variant="ghost"
          className="h-auto min-h-7 w-full justify-start gap-2 rounded-lg px-2 font-normal"
          disabled={!controls?.canDiscard}
          onClick={() => {
            controls?.discard();
            setOpen(false);
          }}
        >
          <Undo2 className="size-3.5" />
          Discard changes
        </Button>
        <Separator className="-mx-1 my-1 w-auto" />
        <label
          htmlFor={`${id}-diff`}
          className={cn(
            "text-fg1 flex min-h-7 items-center justify-between gap-4 rounded-lg px-2 py-1 text-xs leading-4.5",
            canDiff && !diffWaiting && "cursor-pointer",
          )}
        >
          <span className="flex min-w-0 flex-col">
            Diff view
            {diffWaiting && (
              <span className="text-fg3 text-3xxs leading-4">
                Resolve conflicts first
              </span>
            )}
          </span>
          <Switch
            id={`${id}-diff`}
            checked={preferences.diffView}
            disabled={!canDiff || diffWaiting}
            onCheckedChange={(diffView) => {
              setFileEditorPreferences({ diffView });
              onDiffViewChange();
            }}
          />
        </label>
        <label
          htmlFor={`${id}-auto`}
          className="text-fg1 flex min-h-7 cursor-pointer items-center justify-between gap-4 rounded-lg px-2 py-1 text-xs leading-4.5"
        >
          Auto save
          <Switch
            id={`${id}-auto`}
            checked={preferences.autoSave}
            onCheckedChange={(autoSave) =>
              setFileEditorPreferences({ autoSave })
            }
          />
        </label>
      </PopoverContent>
    </Popover>
  );
}
