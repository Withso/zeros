import React, {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Input } from "../../shared/ui/primitives";

/** Timeline text is an editing draft. Incomplete typing must not seek the
 * animation, erase a keyframe value, or change the duration of live playback. */
export function DesignMotionInput({
  value,
  displayValue,
  normalize,
  isValid,
  onValidityChange,
  onCommit,
  ...props
}: Omit<
  React.ComponentProps<typeof Input>,
  "value" | "onChange" | "onFocus" | "onBlur" | "onKeyDown"
> & {
  value: string;
  displayValue?: string;
  normalize?: (value: string) => string;
  isValid?: (value: string) => boolean;
  onValidityChange?: (id: string, valid: boolean) => void;
  onCommit: (value: string) => void;
}) {
  const id = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const baselineRef = useRef(value);
  const cancelledRef = useRef(false);
  const [draft, setDraft] = useState(value);
  const [editing, setEditing] = useState(false);
  const valid = !isValid || isValid(draft);

  useEffect(() => {
    onValidityChange?.(id, valid);
  }, [id, onValidityChange, valid]);
  useEffect(
    () => () => {
      onValidityChange?.(id, true);
    },
    [id, onValidityChange],
  );

  useLayoutEffect(() => {
    if (document.activeElement !== inputRef.current) {
      baselineRef.current = value;
      setDraft(value);
    }
  }, [value]);

  return (
    <Input
      {...props}
      ref={inputRef}
      value={editing ? draft : (displayValue ?? draft)}
      aria-invalid={isValid ? !valid : props["aria-invalid"]}
      onFocus={(event) => {
        // Replace a friendly label before the browser selects text. Deferring
        // this DOM value until React renders can collapse that selection and
        // append the first edit to the old CSS value ("ease-outlinear").
        const input = event.currentTarget;
        if (input.value !== value) {
          const start = input.selectionStart;
          const end = input.selectionEnd;
          const allSelected = start === 0 && end === input.value.length;
          input.value = value;
          if (displayValue !== undefined) {
            input.select();
          } else if (start !== null && end !== null) {
            input.setSelectionRange(
              allSelected ? 0 : Math.min(start, value.length),
              allSelected ? value.length : Math.min(end, value.length),
            );
          }
        }
        baselineRef.current = value;
        cancelledRef.current = false;
        setDraft(value);
        setEditing(true);
      }}
      onChange={(event) => setDraft(event.currentTarget.value)}
      onBlur={() => {
        setEditing(false);
        // An untouched field follows incoming playback/source updates. It
        // never seeks back to the time that happened to be shown on focus.
        if (cancelledRef.current || draft === baselineRef.current) {
          cancelledRef.current = false;
          setDraft(value);
          return;
        }
        const next = normalize ? normalize(draft) : draft.trim();
        if (isValid && !isValid(next)) {
          setDraft(value);
          return;
        }
        setDraft(next);
        baselineRef.current = next;
        if (next !== value) onCommit(next);
      }}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing) return;
        if (event.key === "Enter" || event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          cancelledRef.current = event.key === "Escape";
          event.currentTarget.blur();
        }
      }}
    />
  );
}
