import * as React from "react";
import { CircleAlert } from "lucide-react";

import { cn } from "@/renderer/shared/ui/cn";

// One field box for Input, Textarea and the Select trigger: 13/18 text, 8px
// side padding and a border3 edge that lifts to border4 on hover, so a value
// lines up between an Input and a Select above or below it.
export const FIELD_BOX =
  "rounded-md border border-border3 bg-transparent text-xs leading-4.5 text-fg1 transition-[color,background-color,border-color,box-shadow] duration-120 ease-out hover:border-border4 disabled:cursor-not-allowed disabled:opacity-50";

// The ring is for keyboard focus only: the focus tracker marks focus that Tab
// or arrow navigation brought. A click or typing changes nothing; the caret
// is the cue.
export const FIELD_FOCUS =
  "focus-visible:outline-none focus-visible:data-[zeros-keyboard-focus]:border-highlighted-bright focus-visible:data-[zeros-keyboard-focus]:ring-[3px] focus-visible:data-[zeros-keyboard-focus]:ring-highlighted-bright/50";

export const FIELD_INVALID =
  "aria-[invalid=true]:border-red-primary aria-[invalid=true]:hover:border-red-primary focus-visible:data-[zeros-keyboard-focus]:aria-[invalid=true]:border-red-primary focus-visible:data-[zeros-keyboard-focus]:aria-[invalid=true]:ring-red-primary/30";

export interface FieldProps {
  label: React.ReactNode;
  /** One line under the control; the error replaces it while it shows. */
  hint?: React.ReactNode;
  error?: React.ReactNode;
  /** Marks the label "Optional" in fg3. */
  optional?: boolean;
  className?: string;
  /** One control: an Input, Textarea, Select trigger or InputGroup. */
  children: React.ReactElement<{
    id?: string;
    "aria-describedby"?: string;
    "aria-invalid"?: React.AriaAttributes["aria-invalid"];
  }>;
}

/** Label, control, hint and error: one recipe for every form. The control
 * gets the label's id, the hint or error as its description, and
 * aria-invalid while the error shows. */
export function Field({ label, hint, error, optional = false, className, children }: FieldProps) {
  const generated = React.useId();
  const controlId = children.props.id ?? `${generated}-control`;
  const messageId = `${generated}-message`;
  const message = error ?? hint;
  const describedBy = [children.props["aria-describedby"], message ? messageId : undefined]
    .filter(Boolean)
    .join(" ");
  const control = React.cloneElement(children, {
    id: controlId,
    "aria-describedby": describedBy || undefined,
    ...(error ? { "aria-invalid": true } : {}),
  });
  return (
    <div data-slot="field" className={cn("flex min-w-0 flex-col gap-1.5", className)}>
      <label htmlFor={controlId} className="text-fg1 text-xs leading-4.5 font-medium">
        {label}
        {optional ? <span className="text-fg3 text-3xxs ml-1 font-normal">Optional</span> : null}
      </label>
      {control}
      {error ? (
        <p id={messageId} className="text-red-primary text-3xxs m-0 flex items-center gap-1 leading-4">
          <CircleAlert aria-hidden className="size-3 shrink-0" />
          {error}
        </p>
      ) : hint ? (
        <p id={messageId} className="text-fg3 text-3xxs m-0 leading-4">
          {hint}
        </p>
      ) : null}
    </div>
  );
}
