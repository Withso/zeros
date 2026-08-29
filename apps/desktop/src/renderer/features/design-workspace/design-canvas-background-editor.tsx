import React, { useMemo } from "react";

import { DesignColorPicker, DesignColorSwatch } from "./design-color-picker";
import { designCanvasBackgroundPresentation } from "./design-canvas-background";

interface DesignCanvasBackgroundEditorProps {
  value: string;
  disabled?: boolean;
  onPreview: (value: string) => void;
  onCancelPreview: () => void;
  onCommit: (value: string) => void;
}

export function DesignCanvasBackgroundEditor({
  value,
  disabled = false,
  onPreview,
  onCancelPreview,
  onCommit,
}: DesignCanvasBackgroundEditorProps) {
  const presentation = useMemo(
    () => designCanvasBackgroundPresentation(value),
    [value],
  );

  return (
    <section
      data-design-canvas-background=""
      className="border-border1 border-b p-3"
    >
      <DesignColorPicker
        value={value}
        label="Canvas background"
        disabled={disabled}
        side="left"
        align="start"
        className="bg-bg2 hover:bg-bg2-hover h-9 w-full justify-start gap-2 px-2"
        trigger={
          <>
            <DesignColorSwatch value={value} className="size-5" />
            <span className="text-fg1 min-w-0 flex-1 text-left font-mono text-xs tabular-nums">
              {presentation.hex}
            </span>
            <span className="text-fg2 font-mono text-xs tabular-nums">
              {presentation.opacity} %
            </span>
          </>
        }
        onPreview={onPreview}
        onCancelPreview={onCancelPreview}
        onCommit={onCommit}
      />
    </section>
  );
}
