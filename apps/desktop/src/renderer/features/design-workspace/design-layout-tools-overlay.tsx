import React, { useEffect, useMemo, useRef, useState } from "react";

import {
  designSelectionBox,
  designSelectionOverlayFrame,
  type DesignCanvasRect,
  type DesignSelectionBox,
} from "./design-canvas-math";
import {
  designLayoutChildLocalRect,
  designLayoutPixels,
  designLayoutToolModel,
  designLayoutToolsFit,
  designLocalAxisCursor,
  designSpacingDraft,
  designSpacingLabel,
  designSpacingReadout,
  type DesignGapProperty,
  type DesignGridTrackLayout,
  type DesignLayoutToolGap,
  type DesignPaddingBand,
  type DesignPaddingProperty,
} from "./design-layout-tools";
import {
  settleDesignLayoutToolsLive,
  useDesignLayoutToolsLive,
  type DesignLayoutToolsLiveChild,
} from "./state/design-layout-tools-live";

/** One editable spacing value on the canvas, handed to the gesture owner. */
export interface DesignLayoutSpacingControl {
  kind: "padding" | "gap";
  property: DesignPaddingProperty | DesignGapProperty;
  opposite?: DesignPaddingProperty;
  /** Local axis across the value, and the sign along it that grows it. */
  axis: "x" | "y";
  direction: 1 | -1;
  /** The value a drag starts from (the rendered space for an Auto gap). */
  value: number;
  regionKey?: string;
  automatic?: boolean;
  /** Styles that release an Auto axis once the gap becomes fixed. */
  reset?: Record<string, string>;
  rotation: number;
  scale: { x: number; y: number };
  /** Local tick center, where the readout stays if reflow removes the space. */
  anchor?: { x: number; y: number };
  /** A click that never became a drag opens numeric entry. */
  openEntry: (mirror: "none" | "opposite" | "all") => void;
}

export interface DesignLayoutToolsProps {
  ownerKey: string;
  details: {
    rect: DesignCanvasRect;
    box?: DesignSelectionBox;
    styles: Record<string, string>;
  };
  children: readonly DesignLayoutToolsLiveChild[];
  zoom: number;
  onSpacingPointerDown?: (
    event: React.PointerEvent<HTMLButtonElement>,
    control: DesignLayoutSpacingControl,
  ) => void;
  /** Direct entry and keyboard steps: one source write each. */
  onSpacingCommit?: (
    control: DesignLayoutSpacingControl,
    styles: Record<string, string>,
  ) => Promise<void> | void;
}

type Mirror = "none" | "opposite" | "all";

interface EntryState {
  key: string;
  property: DesignPaddingProperty | DesignGapProperty;
  mirror: Mirror;
  draft: string;
  /** Enter on text that is not a length keeps the field open and says so. */
  invalid?: boolean;
}

/** A spacing value: a non-negative number, optionally in px. */
const ENTRY_PATTERN = /^\s*(\d+(?:\.\d+)?|\.\d+)\s*(?:px)?\s*$/i;

type LocalRect = { x: number; y: number; width: number; height: number };
const overlaps = (a: LocalRect, b: LocalRect) =>
  a.x < b.x + b.width &&
  b.x < a.x + a.width &&
  a.y < b.y + b.height &&
  b.y < a.y + a.height;

const TICK_LONG = 14;
const TICK_SHORT = 4;
const PADDING_TARGET = { long: 28, short: 16 };
/** A padding tick keeps its whole target clear of the four-pixel resize
 * strip on the outer edge, so a thin or zero padding never steals a resize:
 * the tick moves just inside instead. */
const PADDING_EDGE_CLEARANCE = 4 + PADDING_TARGET.short / 2;
/** A gap's dedicated tick target: long along its strip, thick across it. */
const GAP_TICK_TARGET = { long: 24, short: 18 };
const BADGE_OFFSET = 6;
const PADDING_SIDES: readonly DesignPaddingProperty[] = [
  "padding-top",
  "padding-right",
  "padding-bottom",
  "padding-left",
];

function mirroredSides(
  property: DesignPaddingProperty,
  opposite: DesignPaddingProperty | undefined,
  mirror: Mirror,
): DesignPaddingProperty[] {
  if (mirror === "all")
    return PADDING_SIDES.filter((side) => side !== property);
  if (mirror === "opposite" && opposite) return [opposite];
  return [];
}

/** Trapezoids that split a box's padding corners along their diagonals, so a
 * corner belongs to whichever side the pointer is nearer. */
function bandClipPath(
  band: DesignPaddingBand,
  depth: Record<DesignPaddingBand["side"], number>,
): string {
  const px = (value: number) => `${Math.max(0, value)}px`;
  switch (band.side) {
    case "top":
      return `polygon(0 0, 100% 0, calc(100% - ${px(depth.right)}) 100%, ${px(depth.left)} 100%)`;
    case "bottom":
      return `polygon(${px(depth.left)} 0, calc(100% - ${px(depth.right)}) 0, 100% 100%, 0 100%)`;
    case "left":
      return `polygon(0 0, 100% ${px(depth.top)}, 100% calc(100% - ${px(depth.bottom)}), 0 100%)`;
    default:
      return `polygon(0 ${px(depth.top)}, 100% 0, 100% 100%, 0 calc(100% - ${px(depth.bottom)}))`;
  }
}

/** Where a padding readout sits relative to its tick: toward the outside of
 * the box, so it never covers the content the padding surrounds. */
function paddingBadgeStyle(
  side: DesignPaddingBand["side"],
  zoom: number,
): React.CSSProperties {
  const offset = `${(TICK_SHORT / 2 + BADGE_OFFSET) / zoom}px`;
  switch (side) {
    case "top":
      return {
        left: "50%",
        bottom: `calc(50% + ${offset})`,
        translate: "-50% 0",
      };
    case "bottom":
      return { left: "50%", top: `calc(50% + ${offset})`, translate: "-50% 0" };
    case "left":
      return {
        top: "50%",
        right: `calc(50% + ${offset})`,
        translate: "0 -50%",
      };
    default:
      return { top: "50%", left: `calc(50% + ${offset})`, translate: "0 -50%" };
  }
}

function gapBadgeStyle(axis: "x" | "y", zoom: number): React.CSSProperties {
  const offset = `${(TICK_LONG / 2 + BADGE_OFFSET) / zoom}px`;
  return axis === "x"
    ? { left: "50%", bottom: `calc(50% + ${offset})`, translate: "-50% 0" }
    : { top: "50%", left: `calc(50% + ${offset})`, translate: "0 -50%" };
}

function badgeText(value: number, automatic = false): string {
  return automatic
    ? `Auto · ${designSpacingReadout(value)}`
    : designSpacingReadout(value);
}

/** Direct canvas editing of an auto-layout owner's padding and gaps, plus its
 * grid tracks. Geometry is the owner's border box in its own (turned, scaled)
 * space; while a gesture runs, the live store supplies each accepted browser
 * measurement so this island re-renders alone. */
export const DesignLayoutTools = React.memo(function DesignLayoutTools({
  ownerKey,
  details,
  children,
  zoom,
  onSpacingPointerDown,
  onSpacingCommit,
}: DesignLayoutToolsProps) {
  const live = useDesignLayoutToolsLive(ownerKey);
  // Confirmed details supersede any unpinned measurement taken before them.
  useEffect(() => {
    settleDesignLayoutToolsLive(ownerKey);
  }, [details, ownerKey]);
  const geometry = live?.geometry;
  const rect = geometry?.rect ?? details.rect;
  const box = geometry ? geometry.box : details.box;
  const styles = useMemo(
    () =>
      geometry?.styles
        ? { ...details.styles, ...geometry.styles }
        : details.styles,
    [details.styles, geometry?.styles],
  );
  const childList = geometry?.children ?? children;
  const frame = designSelectionOverlayFrame(
    designSelectionBox({ rect, box, styles }),
  );
  const rotation = frame.rotation;
  const scale = useMemo(
    () => ({ x: box?.scaleX ?? 1, y: box?.scaleY ?? 1 }),
    [box?.scaleX, box?.scaleY],
  );
  const model = useMemo(() => {
    const owner = { rect, box, styles };
    return designLayoutToolModel({
      width: frame.width,
      height: frame.height,
      styles,
      scale,
      children: childList.map((child) => ({
        id: child.oid,
        rect: designLayoutChildLocalRect(child, owner),
        position: child.styles.position,
        order: Number.parseInt(child.styles.order ?? "0", 10) || 0,
        margins: {
          top: (designLayoutPixels(child.styles.marginTop) ?? 0) * scale.y,
          right: (designLayoutPixels(child.styles.marginRight) ?? 0) * scale.x,
          bottom:
            (designLayoutPixels(child.styles.marginBottom) ?? 0) * scale.y,
          left: (designLayoutPixels(child.styles.marginLeft) ?? 0) * scale.x,
        },
      })),
    });
  }, [box, childList, frame.height, frame.width, rect, scale, styles]);
  const [hovered, setHovered] = useState<string | null>(null);
  const [entry, setEntry] = useState<EntryState | null>(null);
  const entryInputRef = useRef<HTMLInputElement | null>(null);
  const entrySettledRef = useRef(false);

  useEffect(() => {
    if (!entry) return;
    entrySettledRef.current = false;
    const input = entryInputRef.current;
    input?.focus({ preventScroll: true });
    input?.select();
    // Focus once per opened entry; typing must not reselect the draft.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entry?.key, entry?.mirror]);

  const interaction = live?.interaction;
  const fits = designLayoutToolsFit({
    width: frame.width,
    height: frame.height,
    zoom,
  });
  if (!model || (!fits && !interaction && !entry)) return null;

  const active = interaction?.active ?? entry?.key ?? hovered;
  const mirrored = new Set<string>(
    interaction?.mirrored ??
      (entry && entry.property.startsWith("padding-")
        ? mirroredSides(
            entry.property as DesignPaddingProperty,
            model.bands.find((band) => band.property === entry.property)
              ?.opposite,
            entry.mirror,
          )
        : []),
  );
  const liveValues = interaction?.values ?? {};
  const depth = Object.fromEntries(
    model.bands.map((band) => [
      band.side,
      band.axis === "x" ? band.rect.width : band.rect.height,
    ]),
  ) as Record<DesignPaddingBand["side"], number>;
  const counterRotation = rotation ? `rotate(${-rotation}deg)` : undefined;

  // Every target in local units, so crowding is resolved before anything
  // paints: a gap keeps its tick, and a padding tick that would sit on another
  // control steps aside rather than silently taking that control's presses.
  const clearance = PADDING_EDGE_CLEARANCE / zoom;
  const paddingTicks = new Map(
    model.bands.map((band) => {
      const x =
        band.side === "left"
          ? Math.max(band.handle.x, clearance)
          : band.side === "right"
            ? Math.min(band.handle.x, frame.width - clearance)
            : band.handle.x;
      const y =
        band.side === "top"
          ? Math.max(band.handle.y, clearance)
          : band.side === "bottom"
            ? Math.min(band.handle.y, frame.height - clearance)
            : band.handle.y;
      const width =
        (band.axis === "y" ? PADDING_TARGET.long : PADDING_TARGET.short) / zoom;
      const height =
        (band.axis === "x" ? PADDING_TARGET.long : PADDING_TARGET.short) / zoom;
      return [
        band.property,
        {
          tick: { x, y },
          target: { x: x - width / 2, y: y - height / 2, width, height },
        },
      ] as const;
    }),
  );
  // A gap's pointer target is its real space plus one dedicated tick — never
  // the whole strip inflated over the children beside it. A tick that would
  // land on a padding tick slides along its strip to the nearest free spot.
  const tickLong = GAP_TICK_TARGET.long / zoom;
  const tickThick = GAP_TICK_TARGET.short / zoom;
  const gapTicks = new Map<
    string,
    { x: number; y: number; target: LocalRect }
  >();
  const paddingTargets = [...paddingTicks.values()].map(
    (placed) => placed.target,
  );
  for (const gap of model.gaps) {
    const along = gap.axis === "x" ? "y" : "x";
    const width = gap.axis === "x" ? Math.max(gap.width, tickThick) : tickLong;
    const height =
      gap.axis === "y" ? Math.max(gap.height, tickThick) : tickLong;
    const center = { x: gap.x + gap.width / 2, y: gap.y + gap.height / 2 };
    const stripStart = along === "y" ? gap.y : gap.x;
    const stripLength = along === "y" ? gap.height : gap.width;
    const targetAt = (offset: number): LocalRect => {
      const x = along === "x" ? center.x + offset : center.x;
      const y = along === "y" ? center.y + offset : center.y;
      return { x: x - width / 2, y: y - height / 2, width, height };
    };
    const inStrip = (offset: number) => {
      const middle = (along === "y" ? center.y : center.x) + offset;
      return (
        middle - tickLong / 2 >= stripStart - 0.5 &&
        middle + tickLong / 2 <= stripStart + stripLength + 0.5
      );
    };
    const taken = [
      ...paddingTargets,
      ...[...gapTicks.values()].map((tick) => tick.target),
    ];
    let chosen = 0;
    for (let step = 0; step <= 8; step += 1) {
      const offsets =
        step === 0 ? [0] : [step, -step].map((k) => k * (tickLong + 4 / zoom));
      const free = offsets.find(
        (offset) =>
          (offset === 0 || inStrip(offset)) &&
          !taken.some((rect) => overlaps(rect, targetAt(offset))),
      );
      if (free !== undefined) {
        chosen = free;
        break;
      }
    }
    // Keep the tick clear of the resize strips around the owner's edge.
    const raw = targetAt(chosen);
    const inset = 5 / zoom;
    const x = Math.max(inset, raw.x);
    const y = Math.max(inset, raw.y);
    const target = {
      x,
      y,
      width: Math.max(0, Math.min(frame.width - inset, raw.x + raw.width) - x),
      height: Math.max(
        0,
        Math.min(frame.height - inset, raw.y + raw.height) - y,
      ),
    };
    gapTicks.set(gap.key, {
      x: target.x + target.width / 2,
      y: target.y + target.height / 2,
      target,
    });
  }
  // A padding tick mostly covered by gap targets would only look pressable
  // (gaps sit above it), so it steps aside; one merely grazed stays.
  const gapTargets: LocalRect[] = [
    ...model.gaps.map((gap) => ({
      x: gap.x,
      y: gap.y,
      width: gap.width,
      height: gap.height,
    })),
    ...[...gapTicks.values()].map((tick) => tick.target),
  ];
  const coveredFraction = (target: LocalRect) => {
    const area = target.width * target.height;
    if (area <= 0) return 0;
    let covered = 0;
    for (const hit of gapTargets) {
      if (!overlaps(hit, target)) continue;
      const width =
        Math.min(hit.x + hit.width, target.x + target.width) -
        Math.max(hit.x, target.x);
      const height =
        Math.min(hit.y + hit.height, target.y + target.height) -
        Math.max(hit.y, target.y);
      covered += Math.max(0, width) * Math.max(0, height);
    }
    return Math.min(1, covered / area);
  };
  // Padding ticks may not overlap one another either: every visible tick
  // center must edit its own side. The side being edited always keeps its own.
  const shownBands = new Set<string>();
  const shownTargets: LocalRect[] = [];
  const bandOrder = [...model.bands].sort(
    (left, right) =>
      Number(
        interaction?.active === right.property || entry?.key === right.property,
      ) -
      Number(
        interaction?.active === left.property || entry?.key === left.property,
      ),
  );
  for (const band of bandOrder) {
    const placed = paddingTicks.get(band.property);
    if (!placed) continue;
    const owned =
      interaction?.active === band.property || entry?.key === band.property;
    if (
      owned ||
      (coveredFraction(placed.target) <= 0.5 &&
        !shownTargets.some((rect) => overlaps(rect, placed.target)))
    ) {
      shownBands.add(band.property);
      shownTargets.push(placed.target);
    }
  }
  // While a gap drag reflows its row, the pair it started between may no
  // longer exist; the property keeps the drag's feedback on screen.
  const activeGapKey = interaction
    ? model.gaps.some((gap) => gap.key === interaction.active)
      ? interaction.active
      : (model.gaps.find((gap) => gap.property === interaction.property)?.key ??
        null)
    : active;

  const bandControl = (
    band: DesignPaddingBand,
  ): DesignLayoutSpacingControl => ({
    kind: "padding",
    property: band.property,
    opposite: band.opposite,
    axis: band.axis,
    direction: band.direction,
    value: band.value,
    rotation,
    scale,
    openEntry: (mirror) =>
      setEntry({
        key: band.property,
        property: band.property,
        mirror,
        draft: designSpacingDraft(band.value),
      }),
  });
  const gapControl = (
    gap: DesignLayoutToolGap,
  ): DesignLayoutSpacingControl => ({
    kind: "gap",
    property: gap.property,
    axis: gap.axis,
    direction: gap.direction,
    value: gap.value,
    regionKey: gap.key,
    automatic: gap.automatic,
    reset: gap.reset,
    rotation,
    scale,
    anchor: gapTicks.get(gap.key),
    openEntry: () =>
      setEntry({
        key: gap.key,
        property: gap.property,
        mirror: "none",
        draft: designSpacingDraft(gap.value),
      }),
  });

  const stylesFor = (
    control: DesignLayoutSpacingControl,
    value: number,
    mirror: Mirror,
  ): Record<string, string> => {
    const css = `${Math.max(0, Math.round(value * 100) / 100)}px`;
    const next: Record<string, string> = { [control.property]: css };
    if (control.kind === "padding") {
      for (const side of mirroredSides(
        control.property as DesignPaddingProperty,
        control.opposite,
        mirror,
      )) {
        next[side] = css;
      }
    } else if (control.automatic && control.reset) {
      Object.assign(next, control.reset);
    }
    return next;
  };

  const commitEntry = (control: DesignLayoutSpacingControl) => {
    if (!entry || entrySettledRef.current) return;
    const match = ENTRY_PATTERN.exec(entry.draft);
    if (!match) {
      // A bad value stays, marked invalid, until it is corrected or Escape
      // cancels it — leaving the field does not throw the draft away.
      setEntry((current) =>
        current ? { ...current, invalid: true } : current,
      );
      return;
    }
    entrySettledRef.current = true;
    const parsed = Number(match[1]);
    const current = entry;
    setEntry(null);
    if (!Number.isFinite(parsed) || parsed < 0) return;
    const unchanged =
      Math.abs(parsed - control.value) < 0.005 &&
      current.mirror === "none" &&
      !control.automatic;
    if (unchanged) return;
    void Promise.resolve(
      onSpacingCommit?.(control, stylesFor(control, parsed, current.mirror)),
    ).catch(() => {});
  };

  const keyStep = (
    event: React.KeyboardEvent<HTMLButtonElement>,
    control: DesignLayoutSpacingControl,
  ) => {
    const step = event.shiftKey ? 10 : 1;
    const delta =
      event.key === "ArrowUp" || event.key === "ArrowRight"
        ? step
        : event.key === "ArrowDown" || event.key === "ArrowLeft"
          ? -step
          : 0;
    if (delta !== 0) {
      event.preventDefault();
      event.stopPropagation();
      const next = Math.max(0, control.value + delta);
      if (next === control.value && !control.automatic) return;
      void Promise.resolve(
        onSpacingCommit?.(control, stylesFor(control, next, "none")),
      ).catch(() => {});
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      event.stopPropagation();
      control.openEntry(
        control.kind === "padding" && event.altKey
          ? event.shiftKey
            ? "all"
            : "opposite"
          : "none",
      );
    }
  };

  const entryOpen = (control: DesignLayoutSpacingControl) =>
    entry?.key === (control.regionKey ?? control.property);
  const renderEntry = (
    control: DesignLayoutSpacingControl,
    anchor: React.CSSProperties,
  ) =>
    entry && entryOpen(control) ? (
      <span
        className="pointer-events-none absolute flex items-center justify-center"
        style={anchor}
      >
        <input
          ref={entryInputRef}
          data-design-controls
          data-design-inline-spacing-input={control.property}
          className="zd-design-inline-spacing-input pointer-events-auto absolute z-50 tabular-nums"
          style={{
            ...(control.kind === "padding"
              ? paddingBadgeStyle(
                  (model.bands.find(
                    (band) => band.property === control.property,
                  )?.side ?? "top") as DesignPaddingBand["side"],
                  zoom,
                )
              : gapBadgeStyle(control.axis, zoom)),
            width: `${48 / zoom}px`,
            height: `${20 / zoom}px`,
            fontSize: `${11 / zoom}px`,
            borderWidth: `${1 / zoom}px`,
            borderRadius: `${3 / zoom}px`,
            paddingInline: `${5 / zoom}px`,
            transform: counterRotation,
          }}
          inputMode="decimal"
          aria-label={`${designSpacingLabel(control.property)}${
            entry.mirror === "all"
              ? ", all sides"
              : entry.mirror === "opposite"
                ? ", both sides"
                : ""
          }`}
          value={entry.draft}
          onPointerDown={(event) => event.stopPropagation()}
          aria-invalid={entry.invalid ? true : undefined}
          onChange={(event) =>
            setEntry((current) =>
              current
                ? { ...current, draft: event.target.value, invalid: false }
                : current,
            )
          }
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === "Enter") {
              event.preventDefault();
              commitEntry(control);
            } else if (event.key === "Escape") {
              event.preventDefault();
              entrySettledRef.current = true;
              setEntry(null);
            } else if (event.key === "ArrowUp" || event.key === "ArrowDown") {
              event.preventDefault();
              const parsed = Number.parseFloat(entry.draft);
              const base = Number.isFinite(parsed) ? parsed : control.value;
              const step =
                (event.shiftKey ? 10 : 1) * (event.key === "ArrowUp" ? 1 : -1);
              setEntry((current) =>
                current
                  ? {
                      ...current,
                      draft: designSpacingDraft(Math.max(0, base + step)),
                    }
                  : current,
              );
            }
          }}
          onBlur={() => commitEntry(control)}
        />
      </span>
    ) : null;

  return (
    <span
      data-design-inline-spacing-root=""
      data-design-layout-tools-key={ownerKey}
      data-design-spacing-active={active ?? undefined}
      data-design-spacing-dragging={interaction ? "" : undefined}
      className="zd-design-layout-tools pointer-events-none absolute inset-0"
    >
      {model.kind === "grid" ? (
        <DesignGridTrackGuides
          columns={model.columns}
          rows={model.rows}
          content={model.content}
          zoom={zoom}
          counterRotation={counterRotation}
        />
      ) : null}
      {model.bands.map((band) => {
        const placed = paddingTicks.get(band.property);
        if (!placed || !shownBands.has(band.property)) return null;
        const { tick } = placed;
        const control = bandControl(band);
        const bandActive =
          active === band.property || mirrored.has(band.property);
        const value = liveValues[band.property] ?? band.value;
        const cursor = designLocalAxisCursor(band.axis, rotation);
        return (
          <span
            key={band.property}
            data-design-inline-padding-control={band.property}
            data-active={bandActive ? "" : undefined}
            data-primary={active === band.property ? "" : undefined}
            data-entry={entryOpen(control) ? "" : undefined}
            className="zd-design-inline-padding-control pointer-events-none absolute inset-0"
          >
            {band.rect.width > 0 && band.rect.height > 0 ? (
              <span
                data-design-padding-band={band.property}
                className="zd-design-padding-band pointer-events-auto absolute"
                style={{
                  left: band.rect.x,
                  top: band.rect.y,
                  width: band.rect.width,
                  height: band.rect.height,
                  clipPath: bandClipPath(band, depth),
                }}
                onPointerEnter={() => setHovered(band.property)}
                onPointerLeave={() =>
                  setHovered((current) =>
                    current === band.property ? null : current,
                  )
                }
                onPointerDown={(event) => {
                  // Option-click in a padding area enters a value for both
                  // sides (Shift+Option: all four); a plain press still selects
                  // and moves whatever the canvas finds under it.
                  if (
                    !event.altKey ||
                    event.metaKey ||
                    event.ctrlKey ||
                    event.button !== 0 ||
                    !onSpacingCommit
                  ) {
                    return;
                  }
                  event.preventDefault();
                  event.stopPropagation();
                  control.openEntry(event.shiftKey ? "all" : "opposite");
                }}
              />
            ) : null}
            <span
              data-design-inline-spacing-highlight={band.property}
              className="zd-design-inline-spacing-highlight pointer-events-none absolute"
              style={{
                left: band.rect.x,
                top: band.rect.y,
                width: band.rect.width,
                height: band.rect.height,
              }}
              aria-hidden="true"
            />
            <button
              data-design-controls
              data-design-inline-spacing={band.property}
              data-design-inline-spacing-axis={band.axis}
              data-dragging={
                interaction?.active === band.property ? "true" : undefined
              }
              data-mirrored={
                interaction && mirrored.has(band.property) ? "true" : undefined
              }
              type="button"
              tabIndex={-1}
              className="zd-design-inline-spacing-handle pointer-events-auto absolute z-[45] flex items-center justify-center"
              style={{
                left: tick.x,
                top: tick.y,
                width:
                  (band.axis === "y"
                    ? PADDING_TARGET.long
                    : PADDING_TARGET.short) / zoom,
                height:
                  (band.axis === "x"
                    ? PADDING_TARGET.long
                    : PADDING_TARGET.short) / zoom,
                transform: "translate(-50%, -50%)",
                cursor,
              }}
              aria-label={`${designSpacingLabel(band.property)}, ${designSpacingReadout(value)} pixels`}
              title="Drag to adjust. Option sets both sides, Shift+Option all sides. Click to type."
              onPointerEnter={() => setHovered(band.property)}
              onPointerLeave={() =>
                setHovered((current) =>
                  current === band.property ? null : current,
                )
              }
              onFocus={() => setHovered(band.property)}
              onBlur={() =>
                setHovered((current) =>
                  current === band.property ? null : current,
                )
              }
              onKeyDown={(event) => keyStep(event, control)}
              onPointerDown={(event) => onSpacingPointerDown?.(event, control)}
            >
              <span
                data-design-inline-spacing-line=""
                className="zd-design-inline-spacing-line pointer-events-none absolute box-border border"
                style={{
                  width: (band.axis === "y" ? TICK_LONG : TICK_SHORT) / zoom,
                  height: (band.axis === "x" ? TICK_LONG : TICK_SHORT) / zoom,
                  borderWidth: 1 / zoom,
                  borderRadius: 2 / zoom,
                }}
                aria-hidden="true"
              />
              <span
                data-design-inline-spacing-value={band.property}
                className="zd-design-inline-spacing-value pointer-events-none absolute font-medium whitespace-nowrap tabular-nums"
                style={{
                  ...paddingBadgeStyle(band.side, zoom),
                  minWidth: 20 / zoom,
                  paddingInline: 5 / zoom,
                  borderRadius: 3 / zoom,
                  fontSize: 11 / zoom,
                  lineHeight: `${18 / zoom}px`,
                  transform: counterRotation,
                }}
              >
                {designSpacingReadout(value)}
              </span>
            </button>
            {renderEntry(control, {
              left: tick.x,
              top: tick.y,
              width:
                (band.axis === "y"
                  ? PADDING_TARGET.long
                  : PADDING_TARGET.short) / zoom,
              height:
                (band.axis === "x"
                  ? PADDING_TARGET.long
                  : PADDING_TARGET.short) / zoom,
              transform: "translate(-50%, -50%)",
            })}
          </span>
        );
      })}
      {interaction?.anchor &&
      activeGapKey === null &&
      !interaction.property.startsWith("padding-") ? (
        <span
          data-design-inline-spacing-value={interaction.property}
          data-design-inline-spacing-floating=""
          className="zd-design-inline-spacing-value zd-design-inline-spacing-floating pointer-events-none absolute font-medium whitespace-nowrap tabular-nums"
          style={{
            left: interaction.anchor.x,
            top: interaction.anchor.y,
            translate: "-50% -50%",
            minWidth: 20 / zoom,
            paddingInline: 5 / zoom,
            borderRadius: 3 / zoom,
            fontSize: 11 / zoom,
            lineHeight: `${18 / zoom}px`,
            transform: counterRotation,
          }}
        >
          {designSpacingReadout(interaction.values[interaction.active] ?? 0)}
        </span>
      ) : null}
      {model.gaps.map((gap) => {
        const control = gapControl(gap);
        const primary = activeGapKey === gap.key;
        const propertyActive =
          interaction !== undefined && interaction.property === gap.property;
        const value = liveValues[gap.key] ?? gap.value;
        const automatic = gap.automatic && liveValues[gap.key] === undefined;
        const tick = gapTicks.get(gap.key)!;
        return (
          <React.Fragment key={gap.key}>
            <button
              data-design-controls
              data-design-inline-spacing={gap.property}
              data-design-inline-spacing-axis={gap.axis}
              data-design-inline-gap-region={gap.key}
              data-active={primary || propertyActive ? "" : undefined}
              data-primary={primary ? "" : undefined}
              data-entry={entryOpen(control) ? "" : undefined}
              data-dragging={interaction && primary ? "true" : undefined}
              type="button"
              tabIndex={-1}
              className="zd-design-inline-gap-handle pointer-events-auto absolute z-[46]"
              style={{
                left: gap.x,
                top: gap.y,
                width: gap.width,
                height: gap.height,
                cursor: designLocalAxisCursor(gap.axis, rotation),
              }}
              aria-label={`${designSpacingLabel(gap.property)}, ${
                automatic
                  ? `Auto, ${designSpacingReadout(value)}`
                  : designSpacingReadout(value)
              } pixels`}
              title={
                automatic
                  ? "Auto spacing. Drag or click to set a fixed gap."
                  : "Drag to adjust. Click to type."
              }
              onPointerEnter={() => setHovered(gap.key)}
              onPointerLeave={() =>
                setHovered((current) => (current === gap.key ? null : current))
              }
              onFocus={() => setHovered(gap.key)}
              onBlur={() =>
                setHovered((current) => (current === gap.key ? null : current))
              }
              onKeyDown={(event) => keyStep(event, control)}
              onPointerDown={(event) => onSpacingPointerDown?.(event, control)}
            >
              <span
                data-design-inline-gap-visual=""
                data-design-inline-spacing-highlight={gap.key}
                className="zd-design-inline-spacing-highlight pointer-events-none absolute"
                style={{
                  left: 0,
                  top: 0,
                  width: gap.width,
                  height: gap.height,
                }}
                aria-hidden="true"
              />
              <span
                data-design-inline-gap-tick=""
                className="pointer-events-auto absolute flex items-center justify-center"
                style={{
                  left: tick.target.x - gap.x,
                  top: tick.target.y - gap.y,
                  width: tick.target.width,
                  height: tick.target.height,
                }}
              >
                <span
                  data-design-inline-spacing-line=""
                  className="zd-design-inline-spacing-line pointer-events-none absolute box-border border"
                  style={{
                    width: (gap.axis === "y" ? TICK_LONG : TICK_SHORT) / zoom,
                    height: (gap.axis === "x" ? TICK_LONG : TICK_SHORT) / zoom,
                    borderWidth: 1 / zoom,
                    borderRadius: 2 / zoom,
                  }}
                  aria-hidden="true"
                />
                <span
                  data-design-inline-spacing-value={gap.property}
                  className="zd-design-inline-spacing-value pointer-events-none absolute font-medium whitespace-nowrap tabular-nums"
                  style={{
                    ...gapBadgeStyle(gap.axis, zoom),
                    minWidth: 20 / zoom,
                    paddingInline: 5 / zoom,
                    borderRadius: 3 / zoom,
                    fontSize: 11 / zoom,
                    lineHeight: `${18 / zoom}px`,
                    transform: counterRotation,
                  }}
                >
                  {badgeText(value, automatic)}
                </span>
              </span>
            </button>
            {renderEntry(control, {
              left: tick.target.x,
              top: tick.target.y,
              width: tick.target.width,
              height: tick.target.height,
            })}
          </React.Fragment>
        );
      })}
    </span>
  );
});

/** Dashed track boundaries and upright size labels at the grid's real track
 * edges. Labels that would not fit their track on screen are left out. */
function DesignGridTrackGuides({
  columns,
  rows,
  content,
  zoom,
  counterRotation,
}: {
  columns: DesignGridTrackLayout | null;
  rows: DesignGridTrackLayout | null;
  content: DesignCanvasRect;
  zoom: number;
  counterRotation?: string;
}) {
  const boundaries = (layout: DesignGridTrackLayout | null) =>
    layout
      ? layout.gutters.flatMap((gutter) =>
          gutter.size > 0.5
            ? [gutter.start, gutter.start + gutter.size]
            : [gutter.start],
        )
      : [];
  const labelFits = (size: number) => size * zoom >= 32;
  return (
    <>
      {boundaries(columns).map((x, index) => (
        <span
          key={`column:${index}`}
          data-design-grid-track="column"
          className="zd-design-grid-line pointer-events-none absolute border-l border-dashed"
          style={{
            left: x,
            top: content.y,
            height: content.height,
            borderLeftWidth: 1 / zoom,
          }}
        />
      ))}
      {boundaries(rows).map((y, index) => (
        <span
          key={`row:${index}`}
          data-design-grid-track="row"
          className="zd-design-grid-line pointer-events-none absolute border-t border-dashed"
          style={{
            top: y,
            left: content.x,
            width: content.width,
            borderTopWidth: 1 / zoom,
          }}
        />
      ))}
      {columns?.tracks.map((track, index) =>
        labelFits(track.size) ? (
          <span
            key={`column-label:${index}`}
            data-design-grid-track-label="column"
            className="zd-design-grid-track-label pointer-events-none absolute z-20 font-medium whitespace-nowrap tabular-nums"
            style={{
              left: track.start + track.size / 2,
              top: content.y,
              translate: "-50% -50%",
              transform: counterRotation,
              borderWidth: 1 / zoom,
              borderRadius: 3 / zoom,
              paddingInline: 4 / zoom,
              fontSize: 11 / zoom,
              lineHeight: `${16 / zoom}px`,
            }}
          >
            {designSpacingReadout(track.value)}
          </span>
        ) : null,
      )}
      {rows?.tracks.map((track, index) =>
        labelFits(track.size) ? (
          <span
            key={`row-label:${index}`}
            data-design-grid-track-label="row"
            className="zd-design-grid-track-label pointer-events-none absolute z-20 font-medium whitespace-nowrap tabular-nums"
            style={{
              left: content.x,
              top: track.start + track.size / 2,
              translate: "-50% -50%",
              transform: counterRotation,
              borderWidth: 1 / zoom,
              borderRadius: 3 / zoom,
              paddingInline: 4 / zoom,
              fontSize: 11 / zoom,
              lineHeight: `${16 / zoom}px`,
            }}
          >
            {designSpacingReadout(track.value)}
          </span>
        ) : null,
      )}
    </>
  );
}
