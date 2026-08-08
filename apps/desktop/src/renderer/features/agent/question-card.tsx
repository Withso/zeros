// ──────────────────────────────────────────────────────────
// QuestionCard — the ONE user-input card (composer slot)
// ──────────────────────────────────────────────────────────
//
// The agent asked a blocking question (Claude AskUserQuestion / Codex
// requestUserInput). Unlike the transcript tool card (read-only record), THIS
// is the interactive surface: it takes the composer's slot (like PermissionCard)
// so the user can't miss it, and answering resolves the parked engine turn —
// no queued next-turn prompt.
//
// ONE card covers every shape:
//   • single-select  → highlighted row (one at a time)
//   • multi-select   → checkbox rows (many)
//   • free-text      → the "0  Type something…" last row
//   • N questions    → a `‹ ● ● ● ›` carousel (answer each, then submit once)
//
// Emits a canonical QuestionResponse; the engine adapter reshapes it per provider.
// ──────────────────────────────────────────────────────────

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import {
  ArrowUp,
  Check,
  ChevronLeft,
  ChevronRight,
  Clock,
  X,
} from "lucide-react";

import { cn } from "@/renderer/shared/ui/cn";
import { Button } from "@/renderer/shared/ui/primitives/button";
import { Tooltip } from "@/renderer/shared/ui/primitives";
import { hasShortcutPriorityClaim } from "./shortcut-priority";
import { isInFocusedPane } from "./pane-focus";
import type {
  QuestionRequest,
  QuestionResponse,
  QuestionSpec,
} from "../../platform/bridge/agent-events";

interface QuestionCardProps {
  request: QuestionRequest;
  onRespond: (response: QuestionResponse) => void;
}

/** Per-question working answer. */
interface QState {
  selected: string[]; // option ids
  otherActive: boolean; // the free-text row is chosen
  freeText: string;
}

/** Codex sends no multiSelect flag, so it defaults to MULTI; Claude sets the
 *  value explicitly. */
function isMulti(q: QuestionSpec): boolean {
  return q.multiSelect ?? q.options.length > 0;
}

/** How close to the engine's auto-skip (request.expiresAt) the countdown
 *  becomes visible. The full wait is 30 min (PERMISSION_RESPONSE_TIMEOUT_MS)
 *  — a clock ticking the whole time would read as pressure; the final
 *  5 minutes is the "answer now or the agent proceeds without you" window. */
const SKIP_COUNTDOWN_WINDOW_MS = 5 * 60_000;

/** Ignore card shortcuts for a beat after mount — long enough to absorb a
 *  keystroke already in flight when the card replaces the composer, short
 *  enough to be imperceptible to a user reading the question. Matches
 *  PermissionCard. */
const KEYBOARD_ARM_MS = 250;

function formatCountdown(ms: number): string {
  const totalSec = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** Remaining ms until `expiresAt`, ticking once per second — but only inside
 *  the countdown window. Until then a single timeout sleeps (no 25 minutes of
 *  1s re-renders); null = no deadline / not yet in the window. */
function useSkipCountdown(expiresAt: number | undefined): number | null {
  const [remaining, setRemaining] = useState<number | null>(() => {
    if (typeof expiresAt !== "number") return null;
    const left = expiresAt - Date.now();
    return left <= SKIP_COUNTDOWN_WINDOW_MS ? left : null;
  });
  useEffect(() => {
    if (typeof expiresAt !== "number") return;
    let interval: ReturnType<typeof setInterval> | null = null;
    let starter: ReturnType<typeof setTimeout> | null = null;
    const start = () => {
      setRemaining(expiresAt - Date.now());
      interval = setInterval(() => setRemaining(expiresAt - Date.now()), 1000);
    };
    const untilWindow = expiresAt - SKIP_COUNTDOWN_WINDOW_MS - Date.now();
    if (untilWindow <= 0) start();
    else starter = setTimeout(start, untilWindow);
    return () => {
      if (starter) clearTimeout(starter);
      if (interval) clearInterval(interval);
    };
  }, [expiresAt]);
  return remaining;
}

/** Mouse clicks on card buttons must not leave focus behind: a later keyboard
 *  shortcut (←/→ paging) flips the browser into keyboard modality and reveals
 *  a :focus-visible ring on whatever button held focus — after paging that
 *  ring lands on the new question's option row and reads as an automatic
 *  selection. Suppressing focus on mousedown keeps clicks ring-free while
 *  Tab navigation still works. */
function suppressFocusOnClick(e: ReactMouseEvent) {
  e.preventDefault();
}

function blankState(q: QuestionSpec): QState {
  return { selected: [], otherActive: q.options.length === 0, freeText: "" };
}

function isAnswered(q: QuestionSpec, s: QState): boolean {
  if (s.selected.length > 0) return true;
  if (s.otherActive && s.freeText.trim().length > 0) return true;
  return false;
}

export function QuestionCard({ request, onRespond }: QuestionCardProps) {
  const questions = request.questions;
  const [index, setIndex] = useState(0);
  const [answers, setAnswers] = useState<Record<string, QState>>(() => {
    const init: Record<string, QState> = {};
    for (const q of questions) init[q.id] = blankState(q);
    return init;
  });
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  const q = questions[Math.min(index, questions.length - 1)];
  const qs = answers[q.id] ?? blankState(q);
  const multi = isMulti(q);
  const allAnswered = useMemo(
    () =>
      questions.every((qq) => isAnswered(qq, answers[qq.id] ?? blankState(qq))),
    [questions, answers],
  );

  const patch = useCallback((qid: string, next: Partial<QState>) => {
    setAnswers((a) => ({
      ...a,
      [qid]: {
        ...(a[qid] ?? { selected: [], otherActive: false, freeText: "" }),
        ...next,
      },
    }));
  }, []);

  const toggleOption = useCallback(
    (qid: string, optionId: string, isMultiSelect: boolean) => {
      setAnswers((a) => {
        const cur = a[qid] ?? {
          selected: [],
          otherActive: false,
          freeText: "",
        };
        if (isMultiSelect) {
          const has = cur.selected.includes(optionId);
          return {
            ...a,
            [qid]: {
              ...cur,
              otherActive: false,
              selected: has
                ? cur.selected.filter((x) => x !== optionId)
                : [...cur.selected, optionId],
            },
          };
        }
        // single-select: replace
        return {
          ...a,
          [qid]: { ...cur, otherActive: false, selected: [optionId] },
        };
      });
    },
    [],
  );

  const chooseOther = useCallback((qid: string, isMultiSelect: boolean) => {
    setAnswers((a) => {
      const cur = a[qid] ?? { selected: [], otherActive: false, freeText: "" };
      return {
        ...a,
        [qid]: {
          ...cur,
          otherActive: true,
          // single-select "Other" clears any picked option
          selected: isMultiSelect ? cur.selected : [],
        },
      };
    });
    queueMicrotask(() => inputRef.current?.focus());
  }, []);

  const submit = useCallback(() => {
    if (!allAnswered) return;
    onRespond({
      outcome: {
        outcome: "answered",
        answers: questions.map((qq) => {
          const s = answers[qq.id] ?? blankState(qq);
          const freeText =
            s.otherActive && s.freeText.trim() ? s.freeText.trim() : undefined;
          return { questionId: qq.id, selectedOptionIds: s.selected, freeText };
        }),
      },
    });
  }, [allAnswered, answers, onRespond, questions]);

  const dismiss = useCallback(() => {
    onRespond({ outcome: { outcome: "dismissed" } });
  }, [onRespond]);

  // "Skips in m:ss" — visible for the last stretch before the engine's
  // auto-skip so the timeout is never a surprise. When it hits zero the
  // engine settles the question and AGENT_QUESTION_SETTLED evicts this card.
  const skipRemainingMs = useSkipCountdown(request.expiresAt);
  const showCountdown = skipRemainingMs !== null && skipRemainingMs > 0;

  // Keyboard: digits pick rows (0 = free-text), ←/→ page questions, Enter
  // submits, Esc dismisses. Keys aimed at any OTHER control (an input, an
  // open menu/dialog, any focused element outside this card) belong to that
  // control, not this card — without the guard a stray Enter/Escape anywhere
  // in the app would submit/dismiss the question (same guards as
  // PermissionCard: outside-target, auto-repeat, and a short arming delay
  // that absorbs the keystroke already in flight when the card replaces the
  // composer mid-typing). The card's OWN textarea is exempt: Enter submits
  // and Esc dismisses from inside it, while digits and arrows still
  // type/move the caret there. Bound once.
  const rootRef = useRef<HTMLDivElement | null>(null);
  const armedAtRef = useRef(0);
  useEffect(() => {
    armedAtRef.current = performance.now() + KEYBOARD_ARM_MS;
  }, []);
  const stateRef = useRef({ q, multi, questionsLen: questions.length });
  stateRef.current = { q, multi, questionsLen: questions.length };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat || performance.now() < armedAtRef.current) return;
      // An overlay that owns the keyboard (the composer's agent-model menu —
      // digits typed into its search must not toggle options here) takes
      // precedence while open — capture order alone would let this
      // longer-mounted listener win.
      if (hasShortcutPriorityClaim()) return;
      // Split panes: only the focused pane's card owns these window-level
      // keys — digits must not toggle options in every pane at once.
      if (!isInFocusedPane(rootRef.current)) return;
      const el = document.activeElement;
      const inCardInput = el === inputRef.current;
      const aimedElsewhere =
        !inCardInput &&
        el instanceof HTMLElement &&
        el !== document.body &&
        el !== document.documentElement &&
        !rootRef.current?.contains(el);
      if (aimedElsewhere) return;
      if (e.key === "Escape") {
        e.preventDefault();
        dismiss();
        return;
      }
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        submit();
        return;
      }
      const { q: cq, multi: cmulti, questionsLen } = stateRef.current;
      if (!inCardInput && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
        if (questionsLen <= 1) return;
        e.preventDefault();
        // Paging must not leave a focus ring on a card button (it would read
        // as an auto-selected option on the new question).
        if (el instanceof HTMLElement && el !== inputRef.current) el.blur();
        setIndex((i) =>
          e.key === "ArrowLeft"
            ? Math.max(0, i - 1)
            : Math.min(questionsLen - 1, i + 1),
        );
        return;
      }
      if (inCardInput) return;
      if (/^[0-9]$/.test(e.key)) {
        const n = Number(e.key);
        if (n === 0) {
          if (cq.allowOther) {
            e.preventDefault();
            chooseOther(cq.id, cmulti);
          }
          return;
        }
        const opt = cq.options[n - 1];
        if (opt) {
          e.preventDefault();
          toggleOption(cq.id, opt.id, cmulti);
        }
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [chooseOther, dismiss, submit, toggleOption]);

  return (
    <div ref={rootRef} className="flex w-full min-w-0 flex-col gap-1.5">
      {/* No header row above the card (2026-07-04): the awaiting status is
        the transcript tool row's job — a second "User input · AWAITING
        RESPONSE" line here duplicated it right above the card. */}

      {/* The card */}
      <div className="border-border1 bg-bg1 flex w-full min-w-0 flex-col gap-3 rounded-lg border px-3.5 py-3">
        <div className="flex items-start gap-2">
          {/* Scope/header chip (e.g. COMPONENT SOURCE) intentionally not
            rendered. */}
          <div className="text-fg1 min-w-0 flex-1 text-sm font-medium">
            {q.prompt}
          </div>
          {showCountdown ? (
            <Tooltip label="Skips to default">
              <span
                className={cn(
                  "text-xxs flex shrink-0 items-center gap-1 pt-0.5 font-mono tracking-wide uppercase tabular-nums",
                  skipRemainingMs <= 60_000
                    ? "text-yellow-primary"
                    : "text-fg2",
                )}
                role="timer"
                aria-live="off"
              >
                <Clock className="size-2.5" aria-hidden="true" />
                Skips in {formatCountdown(skipRemainingMs)}
              </span>
            </Tooltip>
          ) : null}
          <Tooltip label="Dismiss">
            <button
              type="button"
              onMouseDown={suppressFocusOnClick}
              onClick={dismiss}
              aria-label="Dismiss (agent proceeds with its default)"
              className="text-fg2 hover:text-fg1 -mt-0.5 -mr-1 shrink-0 rounded-sm p-0.5 transition-colors"
            >
              <X className="size-4" />
            </button>
          </Tooltip>
        </div>

        {/* Option rows */}
        <div className="flex flex-col gap-0.5">
          {q.options.map((opt, i) => {
            const selected = qs.selected.includes(opt.id);
            return (
              <button
                key={opt.id}
                type="button"
                onMouseDown={suppressFocusOnClick}
                onClick={() => toggleOption(q.id, opt.id, multi)}
                className={cn(
                  "group flex w-full items-start gap-3 rounded-md px-2 py-1.5 text-left transition-colors",
                  selected ? "bg-bg2-hover/70" : "hover:bg-bg1-hover",
                )}
              >
                <span className="text-fg2 w-4 shrink-0 pt-0.5 text-right font-mono text-xs">
                  {i + 1}
                </span>
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="text-fg1 text-sm">{opt.label}</span>
                  {opt.description ? (
                    <span className="text-fg2 text-xs">{opt.description}</span>
                  ) : null}
                </span>
                {multi ? (
                  <span
                    className={cn(
                      "mt-0.5 flex size-3.5 shrink-0 items-center justify-center rounded-sm border",
                      selected
                        ? "border-inverted-bg bg-inverted-bg"
                        : "border-border3",
                    )}
                    aria-hidden="true"
                  >
                    {selected ? (
                      <Check
                        className="text-inverted-fg size-2.5"
                        strokeWidth={3}
                      />
                    ) : null}
                  </span>
                ) : null}
              </button>
            );
          })}

          {/* Free-text "Other" row */}
          {q.allowOther ? (
            <div
              className={cn(
                "flex flex-col rounded-md px-2 py-1.5 transition-colors",
                qs.otherActive ? "bg-bg2-hover/70" : "hover:bg-bg1-hover",
              )}
            >
              <button
                type="button"
                onMouseDown={suppressFocusOnClick}
                onClick={() => chooseOther(q.id, multi)}
                className="flex w-full items-center gap-3 text-left"
              >
                <span className="text-fg2 w-4 shrink-0 text-right font-mono text-xs">
                  0
                </span>
                <span
                  className={cn(
                    "text-sm",
                    qs.otherActive ? "text-fg1" : "text-fg2",
                  )}
                >
                  {q.secret ? "Enter a value…" : "Type something…"}
                </span>
              </button>
              {qs.otherActive ? (
                <textarea
                  ref={inputRef}
                  rows={2}
                  value={qs.freeText}
                  onChange={(e) => patch(q.id, { freeText: e.target.value })}
                  {...(q.secret ? { spellCheck: false } : {})}
                  className="text-fg1 placeholder:text-muted-fg border-border1 bg-bg1 focus:border-border2 mt-1.5 ml-7 resize-none rounded-sm border px-2 py-1.5 text-sm outline-none"
                  placeholder={
                    q.secret ? "Value (hidden from logs)" : "Your answer…"
                  }
                  style={
                    q.secret
                      ? ({ WebkitTextSecurity: "disc" } as never)
                      : undefined
                  }
                />
              ) : null}
            </div>
          ) : null}
        </div>

        {/* Footer: carousel (left) · submit (right) */}
        <div className="flex items-center justify-between">
          {questions.length > 1 ? (
            <div className="text-fg2 flex items-center gap-1.5">
              <button
                type="button"
                onMouseDown={suppressFocusOnClick}
                onClick={() => setIndex((i) => Math.max(0, i - 1))}
                disabled={index === 0}
                aria-label="Previous question"
                className="hover:text-fg1 disabled:opacity-30"
              >
                <ChevronLeft className="size-4" />
              </button>
              <div className="flex items-center gap-1">
                {questions.map((qq, i) => {
                  const done = isAnswered(qq, answers[qq.id] ?? blankState(qq));
                  return (
                    <button
                      key={qq.id}
                      type="button"
                      onMouseDown={suppressFocusOnClick}
                      onClick={() => setIndex(i)}
                      aria-label={`Question ${i + 1}${done ? " (answered)" : ""}`}
                      className={cn(
                        "size-1.5 rounded-full transition-colors",
                        i === index ? "bg-fg1" : done ? "bg-fg2" : "bg-border3",
                      )}
                    />
                  );
                })}
              </div>
              <button
                type="button"
                onMouseDown={suppressFocusOnClick}
                onClick={() =>
                  setIndex((i) => Math.min(questions.length - 1, i + 1))
                }
                disabled={index === questions.length - 1}
                aria-label="Next question"
                className="hover:text-fg1 disabled:opacity-30"
              >
                <ChevronRight className="size-4" />
              </button>
            </div>
          ) : (
            <span />
          )}
          <Tooltip
            label={allAnswered ? "Submit" : "Answer all questions"}
            shortcut={allAnswered ? "↵" : undefined}
          >
            <Button
              type="button"
              size="icon"
              variant="default"
              onMouseDown={suppressFocusOnClick}
              onClick={submit}
              disabled={!allAnswered}
              aria-label="Submit answer"
            >
              <ArrowUp className="size-4" />
            </Button>
          </Tooltip>
        </div>
      </div>
    </div>
  );
}
