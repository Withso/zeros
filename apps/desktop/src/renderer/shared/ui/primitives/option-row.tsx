import * as React from "react";
import { ChevronDown, ChevronUp } from "lucide-react";

import { cn } from "@/renderer/shared/ui/cn";
import { Switch } from "./switch";

// One option per row, and the row is the control: 32px on bg2 with 6px
// corners, the name in fg2 at the start and the value in fg1 at the end, in
// the interface font with tabular figures. Used for a component's Options
// only; other panels keep their fields.
const ROW =
  "relative flex h-8 w-full min-w-0 shrink-0 items-center justify-between gap-3 overflow-hidden rounded-md bg-bg2 py-0 pr-1.5 pl-2.5 text-left text-xs leading-4.5 text-fg1";
const FOCUS = "outline-none focus-visible:ring-[3px] focus-visible:ring-highlighted-bright/50";
const LABEL = "relative shrink-0 truncate whitespace-nowrap text-fg2";
const VALUE = "relative inline-flex min-w-0 items-center gap-1.5 whitespace-nowrap pr-1 text-fg1 tabular-nums";
const UNIT = "-ml-0.5 text-3xxs text-fg3";
const FIELD = "relative w-0 min-w-0 flex-1 border-0 bg-transparent p-0 pr-1 text-right text-xs leading-4.5 text-fg1 tabular-nums outline-none";

/** An instance's value that differs from what it inherits: a dot at the
 * row's corner (its variant's value, else the default). */
function ChangedDot({ changed }: { changed?: boolean }) {
  return changed ? <i aria-hidden="true" data-option-changed="" className="bg-blue-primary absolute top-0.75 left-0.75 size-1 rounded-full" /> : null;
}

interface RowProps extends Omit<React.HTMLAttributes<HTMLDivElement>, "children"> {
  label: string;
  changed?: boolean;
  children?: React.ReactNode;
}

/** A row with its name and whatever value or control sits at its end. */
export const OptionRow = React.forwardRef<HTMLDivElement, RowProps>(function OptionRow({ label, changed, children, className, ...rest }, ref) {
  return (
    <div ref={ref} data-option-row="" {...rest} className={cn(ROW, className)}>
      <ChangedDot changed={changed} />
      <span data-option-row-label="" className={LABEL}>{label}</span>
      <span data-option-row-value="" className={VALUE}>{children}</span>
    </div>
  );
});

function stepped(value: number, min: number, max: number, step: number | undefined): number {
  // Whole numbers unless the option says otherwise; steps count from min.
  const unit = step && step > 0 ? step : 1;
  const snapped = Math.round((value - min) / unit) * unit + min;
  const decimals = (String(unit).split(".")[1] ?? "").length;
  return Math.min(max, Math.max(min, Number(snapped.toFixed(decimals))));
}

const formatted = (value: number) => String(value);

/** A value typed in place: Enter or leaving commits, Escape restores. */
function useTypedValue(value: string, onCommit: (text: string) => void, onDone?: () => void) {
  const [text, setText] = React.useState(value);
  const done = React.useRef(false);
  React.useEffect(() => setText(value), [value]);
  return {
    value: text,
    onChange: (event: React.ChangeEvent<HTMLInputElement>) => setText(event.target.value),
    onFocus: () => { done.current = false; },
    onKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.key === "Enter") {
        event.preventDefault();
        done.current = true;
        if (text !== value) onCommit(text);
        onDone?.();
      } else if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        done.current = true;
        setText(value);
        onDone?.();
      }
    },
    onBlur: () => {
      if (!done.current && text !== value) onCommit(text);
      done.current = false;
      onDone?.();
    },
  };
}

interface RangeProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  unit?: string;
  disabled?: boolean;
  changed?: boolean;
  /** While dragged, with each new value. */
  onPreview?: (value: number) => void;
  /** A drag or a typed value that ended without writing (Escape). */
  onCancel?: () => void;
  onCommit: (value: number) => void;
}

/** A number with a range: the row is the slider. The fill shows the value;
 * drag anywhere on the row, a handle marks the edge on hover, click the value
 * to type it, and the arrows step (Shift by ten). */
export function OptionRangeRow({ label, value, min, max, step, unit, disabled = false, changed, onPreview, onCancel, onCommit }: RangeProps) {
  const [shown, setShown] = React.useState(value);
  const [editing, setEditing] = React.useState(false);
  const drag = React.useRef<{ x: number; moved: boolean; id: number | undefined } | null>(null);
  const cancelled = React.useRef(false);
  const rowRef = React.useRef<HTMLDivElement | null>(null);
  React.useEffect(() => {
    if (!drag.current) setShown(value);
  }, [value]);
  const span = max - min || 1;
  const fill = `${Math.round(((shown - min) / span) * 100)}%`;
  const at = (clientX: number) => {
    const box = rowRef.current!.getBoundingClientRect();
    return stepped(min + ((clientX - box.left) / Math.max(1, box.width)) * span, min, max, step);
  };
  const commit = (next: number) => {
    const clamped = stepped(next, min, max, step);
    setShown(clamped);
    onCommit(clamped);
  };
  const typed = useTypedValue(formatted(value), (text) => {
    const number = Number(text.trim());
    if (text.trim() === "" || !Number.isFinite(number)) return;
    commit(number);
  }, () => setEditing(false));

  return (
    <div
      ref={rowRef}
      role="slider"
      tabIndex={disabled ? -1 : 0}
      aria-label={label}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={shown}
      aria-valuetext={unit ? `${shown} ${unit}` : String(shown)}
      aria-disabled={disabled || undefined}
      data-option-row=""
      className={cn(ROW, FOCUS, "group/option touch-none select-none", disabled ? "opacity-50" : "cursor-ew-resize")}
      onKeyDown={(event) => {
        if (disabled || editing) return;
        if (event.key === "Escape" && drag.current) {
          event.preventDefault();
          event.stopPropagation();
          drag.current = null;
          cancelled.current = true;
          setShown(value);
          onCancel?.();
          return;
        }
        const unitStep = step && step > 0 ? step : 1;
        const by = event.shiftKey ? unitStep * 10 : unitStep;
        const next =
          event.key === "ArrowRight" || event.key === "ArrowUp" ? shown + by
            : event.key === "ArrowLeft" || event.key === "ArrowDown" ? shown - by
              : event.key === "PageUp" ? shown + unitStep * 10
                : event.key === "PageDown" ? shown - unitStep * 10
                  : event.key === "Home" ? min
                    : event.key === "End" ? max
                      : null;
        if (event.key === "Enter") {
          event.preventDefault();
          setEditing(true);
          return;
        }
        if (next === null) return;
        event.preventDefault();
        commit(next);
      }}
      onPointerDown={(event) => {
        if (disabled || editing || event.button !== 0) return;
        cancelled.current = false;
        drag.current = { x: event.clientX, moved: false, id: event.pointerId };
        if (event.pointerId !== undefined) event.currentTarget.setPointerCapture?.(event.pointerId);
      }}
      onPointerMove={(event) => {
        const current = drag.current;
        if (!current) return;
        if (!current.moved && Math.abs(event.clientX - current.x) <= 2) return;
        current.moved = true;
        const next = at(event.clientX);
        if (next === shown) return;
        setShown(next);
        onPreview?.(next);
      }}
      onPointerUp={(event) => {
        const current = drag.current;
        drag.current = null;
        if (!current || !current.moved || cancelled.current) return;
        const next = at(event.clientX);
        setShown(next);
        if (next === value) onCancel?.();
        else onCommit(next);
      }}
      onPointerCancel={() => {
        if (!drag.current) return;
        drag.current = null;
        setShown(value);
        onCancel?.();
      }}
    >
      <i aria-hidden="true" data-option-row-fill="" className="bg-bg2-highlight absolute inset-y-0 left-0" style={{ width: fill }} />
      <ChangedDot changed={changed} />
      <b
        aria-hidden="true"
        className="bg-fg3 absolute inset-y-2.25 -ml-1.5 hidden w-0.5 rounded-full group-hover/option:block"
        style={{ left: fill }}
      />
      <span data-option-row-label="" className={LABEL}>{label}</span>
      {editing ? (
        <input
          autoFocus
          aria-label={label}
          inputMode="decimal"
          className={FIELD}
          {...typed}
          onPointerDown={(event) => event.stopPropagation()}
        />
      ) : (
        <span
          data-option-row-value=""
          className={cn(VALUE, !disabled && "cursor-text")}
          onClick={() => {
            if (!disabled && !drag.current) setEditing(true);
          }}
        >
          {shown}
          {unit ? <span className={UNIT}>{unit}</span> : null}
        </span>
      )}
    </div>
  );
}

/** A number without a range: a field typed in place, arrows step. */
export function OptionNumberRow({ label, value, step, unit, disabled = false, changed, onCommit }: {
  label: string; value: number; step?: number; unit?: string; disabled?: boolean; changed?: boolean; onCommit: (value: number) => void;
}) {
  const typed = useTypedValue(formatted(value), (text) => {
    const number = Number(text.trim());
    if (text.trim() !== "" && Number.isFinite(number)) onCommit(number);
  });
  return (
    <div data-option-row="" className={ROW}>
      <ChangedDot changed={changed} />
      <span data-option-row-label="" className={LABEL}>{label}</span>
      <input
        aria-label={label}
        inputMode="decimal"
        disabled={disabled}
        className={cn(FIELD, unit && "pr-0.5", "disabled:opacity-50")}
        {...typed}
        onKeyDown={(event) => {
          if (event.key === "ArrowUp" || event.key === "ArrowDown") {
            event.preventDefault();
            const by = (step && step > 0 ? step : 1) * (event.shiftKey ? 10 : 1);
            onCommit(value + (event.key === "ArrowUp" ? by : -by));
            return;
          }
          typed.onKeyDown(event);
        }}
      />
      {unit ? <span className="text-fg3 relative -ml-2.5 shrink-0 pr-1 text-3xxs">{unit}</span> : null}
    </div>
  );
}

/** On or off: the app's switch at the row's end. */
export function OptionSwitchRow({ label, value, disabled = false, changed, onCommit }: {
  label: string; value: boolean; disabled?: boolean; changed?: boolean; onCommit: (value: boolean) => void;
}) {
  return (
    <OptionRow label={label} changed={changed}>
      <Switch aria-label={label} checked={value} disabled={disabled} onCheckedChange={(checked) => onCommit(checked)} />
    </OptionRow>
  );
}

/** Up to three choices sit in the row; more belong in a menu. */
export function OptionSegmentedRow<T extends string>({ label, value, choices, disabled = false, changed, onCommit }: {
  label: string; value: T; choices: readonly { value: T; label: string }[]; disabled?: boolean; changed?: boolean; onCommit: (value: T) => void;
}) {
  const buttons = React.useRef<(HTMLButtonElement | null)[]>([]);
  return (
    <div data-option-row="" className={ROW}>
      <ChangedDot changed={changed} />
      <span data-option-row-label="" className={LABEL}>{label}</span>
      <div role="radiogroup" aria-label={label} className="relative flex gap-0.5">
        {choices.map((choice, index) => {
          const on = choice.value === value;
          return (
            <button
              key={choice.value}
              ref={(element) => { buttons.current[index] = element; }}
              type="button"
              role="radio"
              aria-checked={on}
              tabIndex={on ? 0 : -1}
              disabled={disabled}
              className={cn(
                FOCUS,
                "h-6 rounded-sm px-2 text-xs leading-4.5 disabled:opacity-50",
                on ? "bg-bg2-highlight text-fg1" : "text-fg2 hover:text-fg1",
              )}
              onClick={() => {
                if (!on) onCommit(choice.value);
              }}
              onKeyDown={(event) => {
                const delta = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;
                if (!delta) return;
                event.preventDefault();
                const next = (index + delta + choices.length) % choices.length;
                buttons.current[next]?.focus();
                onCommit(choices[next]!.value);
              }}
            >
              {choice.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** A row that opens something (a menu, a picker): its value and a chevron. */
export const OptionButtonRow = React.forwardRef<HTMLButtonElement, React.ButtonHTMLAttributes<HTMLButtonElement> & { label: string; chevron?: boolean; changed?: boolean }>(
  function OptionButtonRow({ label, chevron = true, changed, className, children, type = "button", ...rest }, ref) {
    return (
      <button ref={ref} type={type} data-option-row="" {...rest} className={cn(ROW, FOCUS, "hover:bg-bg2-hover disabled:opacity-50", className)}>
        <ChangedDot changed={changed} />
        <span data-option-row-label="" className={LABEL}>{label}</span>
        <span data-option-row-value="" className={cn(VALUE, "[&_svg]:text-fg3 [&_svg]:size-3.5")}>
          {children}
          {chevron ? <ChevronDown aria-hidden="true" /> : null}
        </span>
      </button>
    );
  },
);

/** Text typed in place, right aligned. */
export function OptionTextRow({ label, value, disabled = false, changed, onCommit }: {
  label: string; value: string; disabled?: boolean; changed?: boolean; onCommit: (value: string) => void;
}) {
  const typed = useTypedValue(value, onCommit);
  return (
    <div data-option-row="" className={ROW}>
      <ChangedDot changed={changed} />
      <span data-option-row-label="" className={LABEL}>{label}</span>
      <input aria-label={label} disabled={disabled} className={cn(FIELD, "disabled:opacity-50")} {...typed} />
    </div>
  );
}

/** Options the agent grouped: a heading that folds them. */
export function OptionGroupHeading({ label, expanded, onToggle }: { label: string; expanded: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      aria-expanded={expanded}
      data-option-group=""
      className={cn(FOCUS, "text-fg1 mt-1.5 flex h-7 w-full items-center justify-between rounded-sm pr-1 pl-0.5 text-left text-xs leading-4.5 font-medium [&_svg]:text-fg3 [&_svg]:size-3")}
      onClick={onToggle}
    >
      <span className="truncate">{label}</span>
      {expanded ? <ChevronUp aria-hidden="true" /> : <ChevronDown aria-hidden="true" />}
    </button>
  );
}

/** A row that only does something, such as asking the agent. */
export function OptionActionRow({ className, children, type = "button", ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type={type}
      data-option-row=""
      {...rest}
      className={cn(ROW, FOCUS, "text-fg2 hover:text-fg1 hover:bg-bg2-hover justify-center gap-1.5 disabled:opacity-50 [&_svg]:size-3.5", className)}
    >
      {children}
    </button>
  );
}

/** A new name typed in place: Enter submits it, and a refusal shows under the
 * row; Escape, or leaving it empty, cancels. */
export function OptionEntryRow({ label, inputLabel, placeholder, onSubmit, onCancel }: {
  label: string; inputLabel: string; placeholder?: string;
  /** Null when accepted, else why not. */
  onSubmit: (text: string) => string | null;
  onCancel: () => void;
}) {
  const [text, setText] = React.useState("");
  const [problem, setProblem] = React.useState<string | null>(null);
  return (
    <div className="flex flex-col gap-1">
      <div data-option-row="" className={ROW}>
        <span data-option-row-label="" className={LABEL}>{label}</span>
        <input
          autoFocus
          aria-label={inputLabel}
          aria-invalid={problem ? true : undefined}
          placeholder={placeholder}
          value={text}
          className={cn(FIELD, "placeholder:text-fg3")}
          onChange={(event) => {
            setText(event.target.value);
            setProblem(null);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              setProblem(onSubmit(text));
            } else if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              onCancel();
            }
          }}
          onBlur={() => {
            if (!text.trim()) onCancel();
          }}
        />
      </div>
      {problem ? <p role="alert" className="text-red-fg px-0.5 text-3xxs leading-4">{problem}</p> : null}
    </div>
  );
}
