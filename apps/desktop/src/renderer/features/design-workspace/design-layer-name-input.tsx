import React, { useLayoutEffect, useRef, useState } from "react";
import { Input } from "../../shared/ui/primitives/input";

/** A rename is one edit. Moving focus after Enter/Escape also blurs the
 * input, so settle before handing it back to the tree. */
export function DesignLayerNameInput({
  name,
  maxLength,
  onFinish,
}: {
  name: string;
  maxLength: number;
  onFinish: (name: string | null) => void;
}) {
  const [draft, setDraft] = useState(name);
  const inputRef = useRef<HTMLInputElement>(null);
  const settled = useRef(false);
  useLayoutEffect(() => {
    inputRef.current?.focus({ preventScroll: true });
    inputRef.current?.select();
  }, []);

  const finish = (value: string | null, restoreFocus: boolean) => {
    if (settled.current) return;
    settled.current = true;
    const row = inputRef.current?.closest<HTMLElement>(
      "[data-design-panel-row]",
    );
    onFinish(value);
    if (restoreFocus) row?.focus({ preventScroll: true });
  };

  return (
    <Input
      ref={inputRef}
      aria-label="Layer name"
      className="bg-bg1 text-fg1 h-6 min-w-0 flex-1 px-1 py-0 text-xs"
      value={draft}
      maxLength={maxLength}
      onChange={(event) => setDraft(event.target.value)}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.nativeEvent.isComposing) return;
        if (event.key === "Enter" || event.key === "Escape") {
          event.preventDefault();
          finish(event.key === "Escape" ? null : draft, true);
        }
      }}
      onBlur={() => finish(draft, false)}
    />
  );
}
