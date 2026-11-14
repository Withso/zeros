// PURPOSE: A component's Options section: one row per declared option, which
// is its control. Agents create options; a person only adjusts them here.
// On the main component frame the Variant row picks which variant it shows
// (personal view state) and a row writes that variant's line, or the default
// with Default shown; "Save current as variant…" adds one line. On an
// instance in another frame each row writes the host's attribute, a dot marks
// a value that differs from what it inherits, and Reset removes them all. A
// plain component's instance whose default slot holds only text also offers
// that text, which is the host's own.
// Mounted only for one selected component frame or instance; a folded group
// mounts no rows. Local only.

import { useEffect, useMemo, useState } from "react";
import { Plus, RotateCcw, Sparkles } from "lucide-react";
import { componentInheritedValues } from "@zeros/design-core/component-options";
import type { DesignFrameComponent, DesignFrameInstances } from "@zeros/protocol/design-catalog";
import type { ComponentEasing, ComponentOption, ComponentOptionValue } from "@zeros/design-core/component-options";

import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  toast,
} from "../../shared/ui/primitives";
// Imported directly, not through the primitives index, so the rows load with
// this section rather than with the app.
import {
  OptionActionRow,
  OptionButtonRow,
  OptionEntryRow,
  OptionGroupHeading,
  OptionNumberRow,
  OptionRangeRow,
  OptionRow,
  OptionSegmentedRow,
  OptionSwitchRow,
  OptionTextRow,
} from "../../shared/ui/primitives/option-row";
import { cn } from "../../shared/ui/cn";
import { pillVariants } from "../../shared/ui/primitives/pill";
import type { DesignCanvasFrameWire, DesignLintReportWire } from "../../platform/git";
import { designComponentOptionsBrief, designComponentOptionsFixBrief, type DesignAgentBrief } from "./design-agent-brief";
import { DesignColorPicker } from "./design-color-picker";
import { DesignColorSwatch } from "./design-color-swatch";
import { InspectorIconButton, InspectorSection } from "./design-inspector-kit";
import {
  commitDesignComponentOption,
  commitDesignComponentVariant,
  commitDesignInstanceAttributes,
  commitDesignInstanceText,
  createDesignComponentPreview,
  designComponentAttributeText,
  designComponentPreviewProperties,
  designComponentRecordProblem,
  designComponentVariantName,
  designInstanceIgnoredAttributes,
  designInstanceOptionState,
  readDesignFrameComponent,
  sameDesignComponentValue,
} from "./state/design-component-options";
import { DESIGN_OPTIONS_NOT_APPLIED_MESSAGES } from "./state/design-component-parts";
import { showDesignComponentVariant, useDesignShownComponentVariant } from "./state/design-component-variants";

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

const NO_VALUES: ReadonlyMap<string, ComponentOptionValue> = new Map();
const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));
/** A variant's name as a person reads it: "wide-plan" is Wide plan. */
const variantLabel = (name: string) => {
  const words = name.replace(/-/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
};

/** What the section edits: the main component frame itself, or one instance
 * of a component placed in this frame. */
export type DesignComponentOptionsTarget =
  | { kind: "main"; component: DesignFrameComponent }
  | {
      kind: "instance";
      /** The host layer's data-oid. */
      nodeId: string;
      /** The component's name and title, as the header reads it. */
      title: string;
      host: DesignFrameInstances["hosts"][string];
      component: DesignFrameInstances["components"][string];
      /** What the frame shows when this instance's values did not apply. */
      notApplied?: "last-good" | "defaults" | "nothing";
    };

export function DesignComponentOptions({
  workspaceId,
  frame,
  target,
  directory,
  lint,
  disabled,
  onAskAgent,
}: {
  workspaceId: string;
  frame: DesignCanvasFrameWire;
  target: DesignComponentOptionsTarget;
  directory: string;
  lint: DesignLintReportWire | null;
  disabled: boolean;
  onAskAgent?: (brief: DesignAgentBrief) => void;
}) {
  const instance = target.kind === "instance" ? target : null;
  const view = readDesignFrameComponent(target.component);
  const { declaration } = view;
  const notApplied = instance ? (instance.host.failed ? instance.notApplied ?? "defaults" : undefined) : view.notApplied;
  const shownVariant = useDesignShownComponentVariant(workspaceId, frame);
  // Keyed by the host's record, which a new generation replaces.
  const host = instance?.host;
  const instanceState = useMemo(
    () => (host ? designInstanceOptionState(declaration, host.attributes) : null),
    [declaration, host],
  );
  const variant = instanceState ? instanceState.variant : shownVariant;
  // What a row shows before anything is set here: the main's shown variant,
  // else its defaults; an instance's own values.
  const base = useMemo(
    () => instanceState?.values ?? componentInheritedValues(declaration, shownVariant),
    [declaration, instanceState, shownVariant],
  );
  // A value written and not yet in a new generation: the row keeps showing it.
  // It belongs to the generation and variant it was written against, so a new
  // one shows its own values without another render to clear it.
  const generation = `${frame.sourceVersion}\0${shownVariant ?? ""}`;
  const [unconfirmed, setUnconfirmed] = useState<{ generation: string; values: ReadonlyMap<string, ComponentOptionValue> }>(() => ({ generation, values: NO_VALUES }));
  const pending = unconfirmed.generation === generation ? unconfirmed.values : NO_VALUES;
  // A later generation retires such values for good: an undo restores the
  // bytes, and with them the content hash, of the generation they were
  // written against.
  useEffect(() => {
    setUnconfirmed((previous) => (previous.generation === generation || previous.values === NO_VALUES ? previous : { generation, values: NO_VALUES }));
  }, [generation]);
  const [folded, setFolded] = useState<ReadonlySet<string>>(() => new Set());
  const [naming, setNaming] = useState(false);
  const preview = useMemo(
    () => createDesignComponentPreview(workspaceId, frame.file, frame.sourceVersion, instance?.nodeId),
    [workspaceId, frame.file, frame.sourceVersion, instance?.nodeId],
  );
  useEffect(() => () => preview.clear(), [preview]);

  const current = (option: ComponentOption): ComponentOptionValue => pending.get(option.name) ?? base.get(option.name) ?? option.default;
  const shownValues = () => new Map<string, ComponentOptionValue>(declaration.options.map((entry) => [entry.name, current(entry)]));
  const values = (option: ComponentOption, value: ComponentOptionValue) => shownValues().set(option.name, value);
  const show = (option: ComponentOption, value: ComponentOptionValue) => {
    if (view.reach[option.name] === "css") preview.set(designComponentPreviewProperties(declaration, values(option, value)));
  };
  const failed = (label: string) => (error: unknown) => {
    preview.clear();
    toast.error(`Couldn't change ${label}`, { description: errorMessage(error) });
  };
  const commit = (option: ComponentOption, value: ComponentOptionValue) => {
    if (sameDesignComponentValue(value, current(option))) {
      preview.clear();
      return;
    }
    setUnconfirmed((previous) => ({ generation, values: new Map(previous.generation === generation ? previous.values : NO_VALUES).set(option.name, value) }));
    // A failure after a newer generation arrived has nothing left to undo.
    const forget = () => setUnconfirmed((previous) => {
      if (previous.generation !== generation) return previous;
      const values = new Map(previous.values);
      values.delete(option.name);
      return { generation, values };
    });
    // An instance's value that lands on what it inherits needs no attribute.
    const written = instance && instanceState
      ? commitDesignInstanceAttributes(workspaceId, frame, instance.nodeId,
        { [option.name]: sameDesignComponentValue(value, instanceState.inherited.get(option.name)) ? null : designComponentAttributeText(value) },
        `Set ${option.name}`)
      : commitDesignComponentOption(workspaceId, frame, option.name, value, shownVariant);
    void written.catch((error) => {
      forget();
      failed(option.label)(error);
    });
  };
  const chooseVariant = (next: string | null) => {
    if (next === variant) return;
    if (!instance) {
      showDesignComponentVariant(workspaceId, frame.file, next);
      return;
    }
    void commitDesignInstanceAttributes(workspaceId, frame, instance.nodeId, { "zd-variant": next }, next ? `Use variant ${next}` : "Use Default")
      .catch(failed("the variant"));
  };
  const reset = instance && instanceState?.resettable
    ? () => {
        const removed: Record<string, null> = Object.fromEntries(Object.keys(instance.host.attributes).map((name) => [name, null]));
        void commitDesignInstanceAttributes(workspaceId, frame, instance.nodeId, removed, `Reset ${instance.title}`).catch(failed("the options"));
      }
    : undefined;
  const saveVariant = (typed: string) => {
    const named = designComponentVariantName(declaration, typed);
    if ("error" in named) return named.error;
    setNaming(false);
    void commitDesignComponentVariant(workspaceId, frame, declaration, named.name, shownValues())
      .then(() => showDesignComponentVariant(workspaceId, frame.file, named.name))
      .catch((error) => toast.error("Couldn't save the variant", { description: errorMessage(error) }));
    return null;
  };

  const title = instance ? instance.title : frame.title;
  const askToChange = onAskAgent && !instance ? () => onAskAgent(designComponentOptionsBrief({ directory, frame: frame.file, title })) : undefined;
  const askToFix =
    onAskAgent && notApplied
      ? () =>
          onAskAgent(designComponentOptionsFixBrief({
            directory,
            frame: frame.file,
            title: instance ? `the ${instance.title} instance in ${frame.title}` : title,
            shows: notApplied,
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
    const value = current(option);
    rows.push(
      <DesignComponentOptionRow
        key={option.name}
        option={option}
        value={value}
        inherited={instanceState?.inherited.get(option.name)}
        disabled={disabled}
        onPreview={(next) => show(option, next)}
        onCancel={() => preview.clear()}
        onCommit={(next) => commit(option, next)}
      />,
    );
  }
  const variants = declaration.variants.map((entry) => entry.name);
  const ignored = useMemo(() => (host ? designInstanceIgnoredAttributes(host) : []), [host]);
  const tooLarge = designComponentRecordProblem(target.component, title);

  return (
    <InspectorSection
      title="Options"
      data-design-component-options={instance ? "instance" : "main"}
      bodyClassName="gap-1.5"
      actions={instance ? (
        <InspectorIconButton label="Reset options" data-design-options-reset="" disabled={disabled || !reset} onClick={reset}>
          <RotateCcw />
        </InspectorIconButton>
      ) : undefined}
    >
      {notApplied ? (
        <OptionsNotice tone="error" role="alert" data-design-options-not-applied={notApplied}>
          <p>These options could not be applied. {DESIGN_OPTIONS_NOT_APPLIED_MESSAGES[notApplied]}</p>
          <Button type="button" variant="secondary" size="compact" disabled={!askToFix} onClick={askToFix}>
            <Sparkles aria-hidden="true" />
            Ask agent to fix
          </Button>
        </OptionsNotice>
      ) : null}
      {tooLarge ? (
        <OptionsNotice tone="error" data-design-options-too-large={target.component.exceeds}>
          <p>{tooLarge}</p>
        </OptionsNotice>
      ) : null}
      {ignored.map((message) => (
        <OptionsNotice key={message} tone="warning" data-design-options-ignored="">
          <p>{message}</p>
        </OptionsNotice>
      ))}
      {/* Without its declaration the section cannot list the variants the file declares. */}
      {!tooLarge && (!instance || variants.length) ? (
        <OptionVariantRow
          variant={variant}
          variants={variants}
          disabled={disabled}
          onChoose={chooseVariant}
          onSave={instance ? undefined : () => setNaming(true)}
        />
      ) : null}
      {naming && !tooLarge ? <OptionEntryRow label="Name" inputLabel="Variant name" placeholder="Compact" onSubmit={saveVariant} onCancel={() => setNaming(false)} /> : null}
      {rows}
      {instance && instance.host.text !== undefined ? (
        <OptionTextRow
          label="Text"
          value={instance.host.text}
          disabled={disabled}
          onCommit={(next) => {
            if (next !== instance.host.text) void commitDesignInstanceText(workspaceId, frame, instance.nodeId, next).catch(failed("the text"));
          }}
        />
      ) : null}
      {/* Options are the main's to change, so an instance does not offer it. */}
      {instance ? null : (
        <OptionActionRow disabled={!askToChange} onClick={askToChange} data-design-options-ask="">
          <Sparkles aria-hidden="true" />
          Ask agent to change options
        </OptionActionRow>
      )}
    </InspectorSection>
  );
}

/** A message in this section, shown whole: what it says is the reason. */
function OptionsNotice({ tone, className, children, ...props }: React.HTMLAttributes<HTMLDivElement> & { tone: "error" | "warning" }) {
  return (
    <div
      {...props}
      className={cn("flex flex-col items-start gap-2 rounded-md p-2.5 text-3xxs leading-4.5",
        tone === "error" ? "bg-red-bg text-red-fg" : "bg-yellow-bg text-yellow-fg", className)}
    >
      {children}
    </div>
  );
}

/** Which variant shows (the main) or applies (an instance): Default, then
 * the declared variants; on the main, a way to save the shown values as one. */
function OptionVariantRow({ variant, variants, disabled, onChoose, onSave }: {
  variant: string | null; variants: readonly string[]; disabled: boolean;
  onChoose: (variant: string | null) => void; onSave?: () => void;
}) {
  const menu = (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <OptionButtonRow label="Variant" aria-label="Variant" disabled={disabled} data-design-options-variant="">
          {variant ? variantLabel(variant) : "Default"}
        </OptionButtonRow>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        <DropdownMenuRadioGroup value={variant ?? ""} onValueChange={(next) => onChoose(next || null)}>
          <DropdownMenuRadioItem value="">Default</DropdownMenuRadioItem>
          {variants.map((name) => (
            <DropdownMenuRadioItem key={name} value={name}>{variantLabel(name)}</DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        {onSave ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={onSave}>
              <Plus aria-hidden="true" />
              Save current as variant…
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
  if (!onSave) return menu;
  return (
    <div className="flex items-center gap-1.5">
      <div className="min-w-0 flex-1">{menu}</div>
      <InspectorIconButton label="Save as variant" size="row" className="bg-bg2 size-8 rounded-md" disabled={disabled} onClick={onSave}>
        <Plus />
      </InspectorIconButton>
    </div>
  );
}

interface RowProps<T extends ComponentOptionValue> {
  option: ComponentOption;
  value: T;
  /** An instance's inherited value; absent on the main. */
  inherited?: T;
  disabled: boolean;
  onPreview: (value: ComponentOptionValue) => void;
  onCancel: () => void;
  onCommit: (value: ComponentOptionValue) => void;
}

function DesignComponentOptionRow({ option, value, inherited, disabled, onPreview, onCancel, onCommit }: RowProps<ComponentOptionValue>) {
  // On an instance, a value other than the one it inherits carries a dot.
  const changed = inherited !== undefined && !sameDesignComponentValue(value, inherited);
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
          changed={changed}
          onPreview={onPreview}
          onCancel={onCancel}
          onCommit={onCommit}
        />
      ) : (
        <OptionNumberRow label={option.label} value={value as number} step={option.step} unit={option.unit} disabled={disabled} changed={changed} onCommit={onCommit} />
      );
    case "boolean":
      return <OptionSwitchRow label={option.label} value={value as boolean} disabled={disabled} changed={changed} onCommit={onCommit} />;
    case "choice": {
      const choices = option.choices.map((choice, index) => ({ value: choice, label: option.choiceLabels[index] ?? choice }));
      return choices.length <= SEGMENTED_CHOICES ? (
        <OptionSegmentedRow label={option.label} value={value as string} choices={choices} disabled={disabled} changed={changed} onCommit={onCommit} />
      ) : (
        <OptionMenuRow label={option.label} value={value as string} choices={choices} disabled={disabled} changed={changed} onCommit={onCommit} />
      );
    }
    case "text":
      return <OptionTextRow label={option.label} value={value as string} disabled={disabled} changed={changed} onCommit={onCommit} />;
    case "color":
      return <OptionColorRow label={option.label} value={value as string} disabled={disabled} changed={changed} onPreview={onPreview} onCancel={onCancel} onCommit={onCommit} />;
    case "easing":
      return <OptionEasingRows label={option.label} value={value as ComponentEasing} inherited={inherited as ComponentEasing | undefined} disabled={disabled}
        onPreview={onPreview} onCancel={onCancel} onCommit={onCommit} />;
  }
}

function OptionMenuRow({ label, value, choices, disabled, changed, onCommit }: {
  label: string; value: string; choices: { value: string; label: string }[]; disabled: boolean; changed: boolean; onCommit: (value: string) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <OptionButtonRow label={label} aria-label={label} disabled={disabled} changed={changed}>
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

function OptionColorRow({ label, value, disabled, changed, onPreview, onCancel, onCommit }: {
  label: string; value: string; disabled: boolean; changed: boolean;
  onPreview: (value: string) => void; onCancel: () => void; onCommit: (value: string) => void;
}) {
  const token = TOKEN.exec(value)?.[1];
  return (
    <OptionRow label={label} changed={changed}>
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

function OptionEasingRows({ label, value, inherited, disabled, onPreview, onCancel, onCommit }: {
  label: string; value: ComponentEasing; inherited?: ComponentEasing; disabled: boolean;
  onPreview: (value: ComponentEasing) => void; onCancel: () => void; onCommit: (value: ComponentEasing) => void;
}) {
  const curveChanged = inherited !== undefined && inherited.curve !== value.curve;
  const durationChanged = inherited !== undefined && inherited.duration !== value.duration;
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
        changed={curveChanged}
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
          changed={curveChanged}
          onPreview={(next) => onPreview({ ...value, curve: `spring(${next})` })}
          onCancel={onCancel}
          onCommit={(next) => onCommit({ ...value, curve: `spring(${next})` })}
        />
      ) : (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <OptionButtonRow label="Curve" aria-label={`${label} curve`} disabled={disabled} changed={curveChanged}>
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
        changed={durationChanged}
        onPreview={(next) => onPreview({ ...value, duration: next })}
        onCancel={onCancel}
        onCommit={(next) => onCommit({ ...value, duration: next })}
      />
    </div>
  );
}
