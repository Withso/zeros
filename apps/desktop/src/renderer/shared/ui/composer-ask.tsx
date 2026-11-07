// ──────────────────────────────────────────────────────────
// composer-ask.tsx — the Ask pill an unfocused split pane's composer becomes
// ──────────────────────────────────────────────────────────
//
// 2026-11-07 (Zeros Design v401, "Chat window · Ask to focus"): while the chat
// column is split, an unfocused pane's composer card collapses into one pill,
// "Ask <agent>" with no shortcut, centred where the composer sits. The card
// itself is the pill, so its sidebar-bg fill and composer-border edge carry
// through: pressing it only changes the shape. It expands into the composer
// over 220ms while its label fades out and the composer's contents, kept laid
// out at full width, fade in; the composer the focus leaves folds back over
// 180ms. Cards docked above the composer stay where they are.
// ──────────────────────────────────────────────────────────

import { useLayoutEffect, useRef, type RefObject } from "react";

import { cn } from "./cn";

export const COMPOSER_ASK_EXPAND_MS = 220;
export const COMPOSER_ASK_COLLAPSE_MS = 180;

/** The pill's label inset: 16px each side of the text. */
const ASK_PILL_PADDING_X = 16;

/** One curve for the whole morph: quick to start, long to settle. */
const ASK_EASE = "ease-[cubic-bezier(0.2,0,0,1)]";

/** The composer card's half of the morph, placed after the card's surface
 *  radius. `data-ask-morph` holds the pill's clip and bottom-centre anchor while
 *  the card expands; `data-ask-instant` skips the motion for a retained chat
 *  that is revealed straight into its pane's state (useComposerAskMorph). */
export function composerAskCardClasses(collapsed: boolean): string {
  return cn(
    "group/composer mx-auto [interpolate-size:allow-keywords]",
    "transition-[width,height,border-radius,border-color,background-color,box-shadow]",
    ASK_EASE,
    "motion-reduce:transition-none data-[ask-instant]:transition-none",
    "data-[ask-morph]:overflow-hidden data-[ask-morph]:items-center data-[ask-morph]:justify-end",
    collapsed
      ? cn(
          "h-8 w-(--ask-pill-w) overflow-hidden items-center justify-end rounded-[calc(var(--radius-lg)*2)] duration-180",
          "hover:bg-sidebar-bg-hover hover:border-border3",
          "has-[[data-composer-ask-pill]:focus-visible]:border-highlighted-bright has-[[data-composer-ask-pill]:focus-visible]:ring-[3px] has-[[data-composer-ask-pill]:focus-visible]:ring-highlighted-bright/50",
        )
      : "duration-220",
  );
}

/** The composer's contents inside the card. They keep the full composer width
 *  while the card is a pill or growing out of one, so nothing reflows, and
 *  cross-fade with the pill's label. */
export function composerAskContentClasses(collapsed: boolean): string {
  return cn(
    // interpolate-size inherits; only the card's own size may ease to auto.
    "flex min-w-0 flex-col [interpolate-size:numeric-only] transition-[opacity,translate]",
    ASK_EASE,
    "motion-reduce:transition-none group-data-[ask-instant]/composer:transition-none",
    "group-data-[ask-morph]/composer:min-w-(--composer-content-w)",
    collapsed
      ? "pointer-events-none min-w-(--composer-content-w) translate-y-1 opacity-0 duration-70"
      : "translate-y-0 opacity-100 delay-60 duration-140",
  );
}

const ASK_PILL_CLS =
  "absolute inset-0 z-2 flex items-center justify-center whitespace-nowrap px-4 text-sm text-fg2 outline-none transition-[opacity,color] ease-out motion-reduce:transition-none group-hover/composer:text-fg1 group-data-[ask-instant]/composer:transition-none";

/** The pill's label, over the collapsed card. It stays mounted, faded and out
 *  of reach while the composer is open, so the fold back can fade it in. */
export function ComposerAskPill({
  agent,
  collapsed,
  onActivate,
  buttonRef,
  labelRef,
}: {
  agent: string;
  collapsed: boolean;
  onActivate: () => void;
  buttonRef?: RefObject<HTMLButtonElement>;
  labelRef?: RefObject<HTMLSpanElement>;
}) {
  return (
    <button
      ref={buttonRef}
      type="button"
      data-composer-ask-pill=""
      tabIndex={collapsed ? undefined : -1}
      aria-hidden={collapsed ? undefined : true}
      onClick={onActivate}
      className={cn(
        ASK_PILL_CLS,
        collapsed ? "opacity-100 delay-80 duration-100" : "pointer-events-none opacity-0 duration-70",
      )}
    >
      <span ref={labelRef}>Ask {agent}</span>
    </button>
  );
}

/** Measures the pill and the composer's full width into CSS variables on the
 *  card (no React state, so a window resize never re-renders the chat), and
 *  sequences the morph: the card keeps its clip while it expands, a retained
 *  chat revealed in a pane takes that pane's state without motion, and a pill
 *  that held keyboard focus hands it to the editor. */
export function useComposerAskMorph({
  cardRef,
  columnRef,
  labelRef,
  pillRef,
  collapsed,
  revealed,
  onPillFocusHandoff,
}: {
  cardRef: RefObject<HTMLDivElement>;
  /** The dock column the card spans when open. */
  columnRef: RefObject<HTMLDivElement>;
  labelRef: RefObject<HTMLSpanElement>;
  pillRef: RefObject<HTMLButtonElement>;
  collapsed: boolean;
  /** The chat's surface is on screen. */
  revealed: boolean;
  onPillFocusHandoff: () => void;
}): void {
  const handoffRef = useRef(onPillFocusHandoff);
  handoffRef.current = onPillFocusHandoff;

  useLayoutEffect(() => {
    const card = cardRef.current;
    const column = columnRef.current;
    const label = labelRef.current;
    if (!card || !column || !label) return;
    const px = (value: string) => Number.parseFloat(value) || 0;
    const measure = () => {
      const cardStyle = getComputedStyle(card);
      const columnStyle = getComputedStyle(column);
      const chrome =
        px(cardStyle.paddingLeft) + px(cardStyle.paddingRight) +
        px(cardStyle.borderLeftWidth) + px(cardStyle.borderRightWidth);
      const open = column.clientWidth - px(columnStyle.paddingLeft) - px(columnStyle.paddingRight);
      card.style.setProperty("--composer-content-w", `${Math.max(0, open - chrome)}px`);
      const edge = px(cardStyle.borderLeftWidth) + px(cardStyle.borderRightWidth);
      card.style.setProperty("--ask-pill-w", `${label.offsetWidth + ASK_PILL_PADDING_X * 2 + edge}px`);
    };
    // Reading the card's style before its first paint makes the measured
    // sizes count as a change; that first one must not animate.
    card.setAttribute("data-ask-instant", "");
    measure();
    const frame = requestAnimationFrame(() => card.removeAttribute("data-ask-instant"));
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(column);
    observer?.observe(label);
    return () => {
      cancelAnimationFrame(frame);
      observer?.disconnect();
    };
  }, [cardRef, columnRef, labelRef]);

  const previous = useRef({ collapsed, revealed });
  useLayoutEffect(() => {
    const card = cardRef.current;
    const was = previous.current;
    previous.current = { collapsed, revealed };
    if (!card) return;
    if (revealed && !was.revealed) {
      card.setAttribute("data-ask-instant", "");
      const frame = requestAnimationFrame(() => card.removeAttribute("data-ask-instant"));
      return () => {
        cancelAnimationFrame(frame);
        card.removeAttribute("data-ask-instant");
      };
    }
    if (!was.collapsed || collapsed) {
      card.removeAttribute("data-ask-morph");
      return;
    }
    card.setAttribute("data-ask-morph", "");
    const settle = () => card.removeAttribute("data-ask-morph");
    const timer = window.setTimeout(settle, COMPOSER_ASK_EXPAND_MS + 60);
    const onEnd = (event: TransitionEvent) => {
      if (event.target !== card || event.propertyName !== "height") return;
      window.clearTimeout(timer);
      settle();
    };
    card.addEventListener("transitionend", onEnd);
    // A pill reached with Tab focuses its pane (pane-layout's focusin), so it
    // folds away under the keyboard; the editor takes over once it is reachable.
    if (pillRef.current && document.activeElement === pillRef.current) {
      queueMicrotask(() => handoffRef.current());
    }
    return () => {
      window.clearTimeout(timer);
      card.removeEventListener("transitionend", onEnd);
      settle();
    };
  }, [cardRef, pillRef, collapsed, revealed]);
}
