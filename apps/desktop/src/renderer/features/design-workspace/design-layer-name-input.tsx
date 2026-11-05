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
      size="compact"
      appearance="inline"
      // The field only shows while renaming, so it keeps the editing fill
      // under the pointer too.
      className="bg-bg1 hover:bg-bg1 -ml-0.5 min-w-0 flex-1"
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
