import React from "react";

import { DesignColorField } from "./design-color-picker";
import { InspectorSection } from "./design-inspector-kit";

interface DesignCanvasBackgroundEditorProps {
  value: string;
  disabled?: boolean;
  onPreview: (value: string) => void;
  onCancelPreview: () => void;
  onCommit: (value: string) => void;
}

/** With nothing selected the inspector edits the canvas itself: one Figma
 * "Page" color row (swatch, hex and opacity). */
export function DesignCanvasBackgroundEditor({
  value,
  disabled = false,
  onPreview,
  onCancelPreview,
  onCommit,
}: DesignCanvasBackgroundEditorProps) {
  return (
    <InspectorSection title="Background" data-design-canvas-background="">
      <DesignColorField
        value={value}
        label="Canvas background"
        disabled={disabled}
        onPreview={onPreview}
        onCancelPreview={onCancelPreview}
        onCommit={onCommit}
      />
    </InspectorSection>
  );
}
