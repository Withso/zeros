// PURPOSE: The Options section of a component frame: one row per declared
// option, which is its control. Agents create options; a person only
// adjusts them here (the one authoring affordance is "Ask agent to change
// options"). The main component shows and writes its declared defaults.
// Mounted only while the frame itself is selected and its file declares
// options; a folded group mounts no rows. Local only.

import { useEffect, useMemo, useState } from "react";
import { Sparkles } from "lucide-react";
import type { ComponentEasing, ComponentOption, ComponentOptionValue } from "@zeros/design-core/component-options";

import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
  toast,
} from "../../shared/ui/primitives";
// Imported directly, not through the primitives index, so the rows load with
// this section rather than with the app.
import {
  OptionActionRow,
  OptionButtonRow,
  OptionGroupHeading,
  OptionNumberRow,
  OptionRangeRow,
  OptionRow,
  OptionSegmentedRow,
  OptionSwitchRow,
  OptionTextRow,
} from "../../shared/ui/primitives/option-row";
import { pillVariants } from "../../shared/ui/primitives/pill";
import type { DesignCanvasFrameWire, DesignLintReportWire } from "../../platform/git";
import { designComponentOptionsBrief, designComponentOptionsFixBrief, type DesignAgentBrief } from "./design-agent-brief";
import { DesignColorPicker } from "./design-color-picker";
import { DesignColorSwatch } from "./design-color-swatch";
import { InspectorSection } from "./design-inspector-kit";
import {
  commitDesignComponentOption,
  createDesignComponentPreview,
  designComponentPreviewProperties,
  readDesignFrameComponent,
} from "./state/design-component-options";

const EASINGS = [
  { value: "linear", label: "Linear" },
  { value: "ease", label: "Ease" },
  { value: "ease-in", label: "Ease in" },
  { value: "ease-out", label: "Ease out" },
  { value: "ease-in-out", label: "Ease in out" },
] as const;
/** Up to this many choices sit in the row; more become a menu. */
const SEGMENTED_CHOICES = 3;
const MAX_DURATION_MS = 1_000;

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));
const sameValue = (left: ComponentOptionValue, right: ComponentOptionValue) =>
  typeof left === "object" && typeof right === "object"
    ? left.curve === right.curve && left.duration === right.duration
    : left === right;

export function DesignComponentOptions({
  workspaceId,
  frame,
  directory,
  lint,
  disabled,
  onAskAgent,
}: {
  workspaceId: string;
  frame: DesignCanvasFrameWire & { component: NonNullable<DesignCanvasFrameWire["component"]> };
  directory: string;
  lint: DesignLintReportWire | null;
  disabled: boolean;
  onAskAgent?: (brief: DesignAgentBrief) => void;
}) {
  const view = readDesignFrameComponent(frame.component);
  const { declaration } = view;
  // A value written and not yet in a new generation: the row keeps showing it.
  const [pending, setPending] = useState<ReadonlyMap<string, ComponentOptionValue>>(() => new Map());
  const [folded, setFolded] = useState<ReadonlySet<string>>(() => new Set());
  useEffect(() => setPending(new Map()), [frame.sourceVersion]);
  const preview = useMemo(
    () => createDesignComponentPreview(workspaceId, frame.file, frame.sourceVersion),
    [workspaceId, frame.file, frame.sourceVersion],
  );
  useEffect(() => () => preview.clear(), [preview]);

  const current = (option: ComponentOption): ComponentOptionValue => pending.get(option.name) ?? option.default;
  const values = (option: ComponentOption, value: ComponentOptionValue) => {
    const all = new Map<string, ComponentOptionValue>(declaration.options.map((entry) => [entry.name, current(entry)]));
    all.set(option.name, value);
    return all;
  };
  const show = (option: ComponentOption, value: ComponentOptionValue) => {
    if (view.reach[option.name] === "css") preview.set(designComponentPreviewProperties(declaration, values(option, value)));
  };
  const commit = (option: ComponentOption, value: ComponentOptionValue) => {
    if (sameValue(value, current(option))) {
      preview.clear();
      return;
    }
    setPending((previous) => new Map(previous).set(option.name, value));
    void commitDesignComponentOption(workspaceId, frame, option.name, value).catch((error) => {
      preview.clear();
      setPending((previous) => {
        const next = new Map(previous);
        next.delete(option.name);
        return next;
      });
      toast.error(`Couldn't change ${option.label}`, { description: errorMessage(error) });
    });
  };

  const title = frame.title;
  const askToChange = onAskAgent ? () => onAskAgent(designComponentOptionsBrief({ directory, frame: frame.file, title })) : undefined;
  const askToFix =
    onAskAgent && view.notApplied
      ? () =>
          onAskAgent(designComponentOptionsFixBrief({
            directory,
            frame: frame.file,
            title,
            shows: view.notApplied!,
            problems: (lint?.violations ?? [])
              .filter((violation) => violation.file === frame.file && violation.ruleId.startsWith("component-"))
              .slice(0, 20)
              .map((violation) => ({ line: violation.line, message: violation.message })),
          }))
      : undefined;

  const rows: React.ReactNode[] = [];
  let group: string | undefined;
  for (const option of declaration.options) {
    if (option.group !== group) {
      group = option.group;
      if (group) {
        const name = group;
        rows.push(
          <OptionGroupHeading
            key={`group:${name}:${option.name}`}
            label={name}
            expanded={!folded.has(name)}
            onToggle={() => setFolded((previous) => {
              const next = new Set(previous);
              if (!next.delete(name)) next.add(name);
              return next;
            })}
          />,
        );
      }
    }
    if (option.group && folded.has(option.group)) continue;
    rows.push(
      <DesignComponentOptionRow
        key={option.name}
        option={option}
        value={current(option)}
        disabled={disabled}
        onPreview={(value) => show(option, value)}
        onCancel={() => preview.clear()}
        onCommit={(value) => commit(option, value)}
      />,
    );
  }

  return (
    <InspectorSection title="Options" data-design-component-options="" bodyClassName="gap-1.5">
      {view.notApplied ? (
        <div role="alert" data-design-options-not-applied={view.notApplied} className="bg-red-bg text-red-fg flex flex-col items-start gap-2 rounded-md p-2.5 text-3xxs leading-4.5">
          <p>
            {view.notApplied === "last-good"
              ? "These options could not be applied. The frame shows its last good render."
              : "These options could not be applied. The frame shows the component's defaults."}
          </p>
          <Button type="button" variant="secondary" size="compact" disabled={!askToFix} onClick={askToFix}>
            <Sparkles aria-hidden="true" />
            Ask agent to fix
          </Button>
        </div>
      ) : null}
      {rows}
      <OptionActionRow disabled={!askToChange} onClick={askToChange} data-design-options-ask="">
        <Sparkles aria-hidden="true" />
        Ask agent to change options
      </OptionActionRow>
    </InspectorSection>
  );
}

interface RowProps<T extends ComponentOptionValue> {
  option: ComponentOption;
  value: T;
  disabled: boolean;
  onPreview: (value: ComponentOptionValue) => void;
  onCancel: () => void;
  onCommit: (value: ComponentOptionValue) => void;
}

function DesignComponentOptionRow({ option, value, disabled, onPreview, onCancel, onCommit }: RowProps<ComponentOptionValue>) {
  switch (option.kind) {
    case "number":
      return option.min !== undefined && option.max !== undefined ? (
        <OptionRangeRow
          label={option.label}
          value={value as number}
          min={option.min}
          max={option.max}
          step={option.step}
          unit={option.unit}
          disabled={disabled}
          onPreview={onPreview}
          onCancel={onCancel}
          onCommit={onCommit}
        />
      ) : (
        <OptionNumberRow label={option.label} value={value as number} step={option.step} unit={option.unit} disabled={disabled} onCommit={onCommit} />
      );
    case "boolean":
      return <OptionSwitchRow label={option.label} value={value as boolean} disabled={disabled} onCommit={onCommit} />;
    case "choice": {
      const choices = option.choices.map((choice, index) => ({ value: choice, label: option.choiceLabels[index] ?? choice }));
      return choices.length <= SEGMENTED_CHOICES ? (
        <OptionSegmentedRow label={option.label} value={value as string} choices={choices} disabled={disabled} onCommit={onCommit} />
      ) : (
        <OptionMenuRow label={option.label} value={value as string} choices={choices} disabled={disabled} onCommit={onCommit} />
      );
    }
    case "text":
      return <OptionTextRow label={option.label} value={value as string} disabled={disabled} onCommit={onCommit} />;
    case "color":
      return <OptionColorRow label={option.label} value={value as string} disabled={disabled} onPreview={onPreview} onCancel={onCancel} onCommit={onCommit} />;
    case "easing":
      return <OptionEasingRows label={option.label} value={value as ComponentEasing} disabled={disabled} onPreview={onPreview} onCancel={onCancel} onCommit={onCommit} />;
  }
}

function OptionMenuRow({ label, value, choices, disabled, onCommit }: {
  label: string; value: string; choices: { value: string; label: string }[]; disabled: boolean; onCommit: (value: string) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <OptionButtonRow label={label} aria-label={label} disabled={disabled}>
          {choices.find((choice) => choice.value === value)?.label ?? value}
        </OptionButtonRow>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        <DropdownMenuRadioGroup value={value} onValueChange={(next) => { if (next !== value) onCommit(next); }}>
          {choices.map((choice) => (
            <DropdownMenuRadioItem key={choice.value} value={choice.value}>{choice.label}</DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const TOKEN = /^var\(\s*--([A-Za-z0-9_-]+)\s*\)$/;

function OptionColorRow({ label, value, disabled, onPreview, onCancel, onCommit }: {
  label: string; value: string; disabled: boolean;
  onPreview: (value: string) => void; onCancel: () => void; onCommit: (value: string) => void;
}) {
  const token = TOKEN.exec(value)?.[1];
  return (
    <OptionRow label={label}>
      <DesignColorPicker
        value={value}
        label={label}
        disabled={disabled}
        tokenName={token}
        className="size-auto h-6 gap-1.5 rounded-sm px-0"
        trigger={
          <>
            {token ? <span className={pillVariants({ tone: "token" })}>{token}</span> : <span className="text-fg1 tabular-nums">{value}</span>}
            <DesignColorSwatch value={value} className="size-4.5" />
          </>
        }
        onPreview={onPreview}
        onCancelPreview={onCancel}
        onCommit={onCommit}
      />
    </OptionRow>
  );
}

const SPRING = /^spring\(([^)]*)\)$/;
const KEYWORD_CURVES: Record<string, [number, number, number, number]> = {
  linear: [0, 0, 1, 1],
  ease: [0.25, 0.1, 0.25, 1],
  "ease-in": [0.42, 0, 1, 1],
  "ease-out": [0, 0, 0.58, 1],
  "ease-in-out": [0.42, 0, 0.58, 1],
};

/** The curve as a path in a 240 × 96 box with a 6px inset. */
function curvePath(curve: string): string {
  const x = (t: number) => 6 + t * 228;
  const y = (v: number) => 86 - v * 74;
  const spring = SPRING.exec(curve);
  if (spring) {
    const bounce = Math.min(Math.max(Number(spring[1]), 0), 1);
    const damping = 1 - bounce * 0.9;
    const omega = 2 * Math.PI * 1.6;
    const points: string[] = [];
    for (let index = 0; index <= 48; index += 1) {
      const t = index / 48;
      let v: number;
      if (damping >= 1) v = 1 - Math.exp(-omega * t) * (1 + omega * t);
      else {
        const damped = omega * Math.sqrt(1 - damping * damping);
        v = 1 - Math.exp(-damping * omega * t) * (Math.cos(damped * t) + ((damping * omega) / damped) * Math.sin(damped * t));
      }
      points.push(`${x(t).toFixed(1)} ${y(index === 48 ? 1 : v).toFixed(1)}`);
    }
    return `M${points.join("L")}`;
  }
  const cubic = /^cubic-bezier\(([^)]*)\)$/.exec(curve)?.[1]?.split(",").map(Number);
  const [x1, y1, x2, y2] = cubic && cubic.length === 4 ? cubic : KEYWORD_CURVES[curve] ?? KEYWORD_CURVES.ease!;
  return `M${x(0)} ${y(0)}C${x(x1!)} ${y(y1!)} ${x(x2!)} ${y(y2!)} ${x(1)} ${y(1)}`;
}

function OptionEasingRows({ label, value, disabled, onPreview, onCancel, onCommit }: {
  label: string; value: ComponentEasing; disabled: boolean;
  onPreview: (value: ComponentEasing) => void; onCancel: () => void; onCommit: (value: ComponentEasing) => void;
}) {
  const spring = SPRING.exec(value.curve);
  const bounce = spring ? Number(spring[1]) : 0;
  const keyword = EASINGS.find((easing) => easing.value === value.curve);
  return (
    <div role="group" aria-label={label} className="flex flex-col gap-1.5" data-design-option-easing={spring ? "spring" : "curve"}>
      {/* A component may declare several easings; the name says which curve this is. */}
      <span className="text-fg2 mt-1.5 px-0.5 text-3xxs leading-4">{label}</span>
      <div role="img" aria-label={`${label} curve`} className="bg-bg2 text-fg2 relative h-24 overflow-hidden rounded-md">
        <svg viewBox="0 0 240 96" preserveAspectRatio="none" fill="none" stroke="currentColor" aria-hidden="true" className="block size-full">
          <path d="M0 48h240M80 0v96M160 0v96" strokeWidth="1" opacity="0.25" />
          <path d={curvePath(value.curve)} strokeWidth="2" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
        </svg>
      </div>
      <OptionSegmentedRow
        label="Type"
        value={spring ? "spring" : "easing"}
        choices={[{ value: "easing", label: "Easing" }, { value: "spring", label: "Spring" }]}
        disabled={disabled}
        onCommit={(type) => onCommit({ ...value, curve: type === "spring" ? "spring(0.2)" : "ease-out" })}
      />
      {spring ? (
        <OptionRangeRow
          label="Bounce"
          value={bounce}
          min={0}
          max={1}
          step={0.05}
          disabled={disabled}
          onPreview={(next) => onPreview({ ...value, curve: `spring(${next})` })}
          onCancel={onCancel}
          onCommit={(next) => onCommit({ ...value, curve: `spring(${next})` })}
        />
      ) : (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <OptionButtonRow label="Curve" aria-label={`${label} curve`} disabled={disabled}>
              {keyword?.label ?? "Custom"}
            </OptionButtonRow>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            <DropdownMenuRadioGroup value={keyword?.value ?? ""} onValueChange={(next) => { if (next !== value.curve) onCommit({ ...value, curve: next }); }}>
              {EASINGS.map((easing) => (
                <DropdownMenuRadioItem key={easing.value} value={easing.value}>{easing.label}</DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      <OptionRangeRow
        label="Duration"
        value={value.duration}
        min={0}
        max={Math.max(MAX_DURATION_MS, value.duration)}
        unit="ms"
        disabled={disabled}
        onPreview={(next) => onPreview({ ...value, duration: next })}
        onCancel={onCancel}
        onCommit={(next) => onCommit({ ...value, duration: next })}
      />
    </div>
  );
}
