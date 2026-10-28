import { useEffect, useId, useState } from "react";
import { Save, SlidersHorizontal, Undo2 } from "lucide-react";
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
}

export function FileEditorOptions({
  active,
  controls,
  canDiff,
  onDiffViewChange,
}: {
  active: boolean;
  controls: FileEditorControls | null;
  canDiff: boolean;
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
        <IconButton label="File options" size="compact" disabled={!active}>
          <SlidersHorizontal className="size-3.5" />
        </IconButton>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-60 p-1.5"
        aria-label="File options"
      >
        <Button
          variant="ghost"
          className="w-full justify-start font-normal"
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
          className="w-full justify-start font-normal"
          disabled={!controls?.canDiscard}
          onClick={() => {
            controls?.discard();
            setOpen(false);
          }}
        >
          <Undo2 className="size-3.5" />
          Discard changes
        </Button>
        <Separator className="my-1.5" />
        <label
          htmlFor={`${id}-diff`}
          className="text-fg2 flex min-h-8 cursor-pointer items-center justify-between gap-4 px-2 py-1 text-xs"
        >
          Diff view
          <Switch
            id={`${id}-diff`}
            checked={preferences.diffView}
            disabled={!canDiff}
            onCheckedChange={(diffView) => {
              setFileEditorPreferences({ diffView });
              onDiffViewChange();
            }}
          />
        </label>
        <label
          htmlFor={`${id}-auto`}
          className="text-fg2 flex min-h-8 cursor-pointer items-center justify-between gap-4 px-2 py-1 text-xs"
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
