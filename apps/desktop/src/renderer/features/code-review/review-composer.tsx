import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { CODE_REVIEW_BODY_LIMIT } from "@zeros/protocol/code-review";
import { Button, ButtonShortcut, Textarea } from "@/renderer/shared/ui/primitives";
import { cn } from "@/renderer/shared/ui/cn";
import type { ReviewDraftStore } from "./review-draft-store";

/** The agent composer's look for review drafts: sidebar-bg with a border2
 *  edge that stays put on focus, the range as its title, a borderless 13/20
 *  text area and one footer (where it goes, Cancel, then the primary submit
 *  with its ⌘↵). */
export function ReviewComposer({
  store,
  draftKey,
  label,
  showLabel = true,
  submitLabel = "Comment",
  active,
  onSubmit,
  onCancel,
  onSubmitted,
  destination,
  notice,
  variant = "card",
}: {
  store: ReviewDraftStore;
  draftKey: string;
  label: string;
  /** A reply keeps its label as the box's name without printing it. */
  showLabel?: boolean;
  submitLabel?: string;
  active: boolean;
  onSubmit: (body: string, requestId: string) => Promise<void>;
  onCancel: () => void;
  onSubmitted?: () => void;
  /** Where the comment goes, at the footer's start. */
  destination?: ReactNode;
  /** A line above the footer, such as a moved PR diff. */
  notice?: ReactNode;
  /** A reply box takes the reply field's place beside your avatar: 6px
   *  corners, a two-line area and a tighter footer. */
  variant?: "card" | "reply";
}) {
  const reply = variant === "reply";
  const id = useId();
  const textarea = useRef<HTMLTextAreaElement>(null);
  const subscribe = useCallback(
    (listener: () => void) => store.subscribe(draftKey, listener),
    [store, draftKey],
  );
  const getSnapshot = useCallback(
    () => store.getSnapshot(draftKey),
    [store, draftKey],
  );
  const draft = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  useEffect(() => {
    // A virtual slot remount is not a new focus intent. Only opening a
    // composer requests focus, and hidden retained surfaces never consume it.
    if (active && store.takeFocus(draftKey)) textarea.current?.focus();
  }, [active, draftKey, store]);
  const submit = useCallback(() => {
    if (!active) return;
    void store.submit(draftKey, onSubmit).then((result) => {
      if (result === "submitted") onSubmitted?.();
    });
  }, [active, store, draftKey, onSubmit, onSubmitted]);

  return (
    <form
      data-review-composer
      aria-label={label}
      aria-busy={draft.busy || undefined}
      className={cn(
        "border-border2 bg-sidebar-bg flex min-w-0 flex-col border font-sans",
        reply ? "rounded-md" : "rounded-lg",
      )}
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
      onKeyDown={(event) => {
        if (!active || event.nativeEvent.isComposing) return;
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          if (!draft.busy) onCancel();
        } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
          event.preventDefault();
          event.stopPropagation();
          submit();
        }
      }}
    >
      <label
        htmlFor={id}
        className={cn(
          "text-fg1 px-3 pt-2.5 text-xs leading-4.5 font-medium",
          !showLabel && "sr-only",
        )}
      >
        {label}
      </label>
      <Textarea
        ref={textarea}
        id={id}
        aria-describedby={draft.error ? `${id}-error` : undefined}
        value={draft.body}
        maxLength={CODE_REVIEW_BODY_LIMIT}
        rows={reply ? 2 : 3}
        placeholder={reply ? "Write a reply…" : "Write a comment…"}
        className={cn(
          // Borderless inside the box, and unchanged on focus: the caret is
          // the cue. Sending dims the text until the write lands.
          "resize-y border-transparent text-xs leading-5 shadow-none hover:border-transparent focus-visible:data-[zeros-keyboard-focus]:border-transparent focus-visible:data-[zeros-keyboard-focus]:ring-0",
          reply
            ? "min-h-12 px-2.5 pt-1.75 pb-0.5"
            : cn("min-h-16 px-3 py-1.5", showLabel ? "pt-1" : "pt-2.5"),
          draft.busy && "text-fg3",
        )}
        disabled={!active}
        onChange={(event) => store.setBody(draftKey, event.target.value)}
      />
      {draft.error && (
        <p
          id={`${id}-error`}
          role="alert"
          className="text-red-primary px-3 text-xs leading-4.5 break-words"
        >
          {draft.error}
        </p>
      )}
      {notice ? <div className="px-3 pt-1">{notice}</div> : null}
      <div
        className={cn(
          "flex items-center justify-end gap-1",
          reply ? "pt-1 pr-1.5 pb-1.5 pl-2.5" : "p-2",
        )}
      >
        {destination ? (
          <div className="mr-auto flex min-w-0 items-center">{destination}</div>
        ) : null}
        <Button
          type="button"
          variant="ghost"
          disabled={draft.busy || !active}
          onClick={onCancel}
        >
          Cancel
        </Button>
        <Button
          type="submit"
          variant="primary"
          loading={draft.busy}
          disabled={!draft.body.trim() || !active}
          aria-label={submitLabel}
          aria-keyshortcuts="Meta+Enter Control+Enter"
        >
          {draft.busy ? "Sending…" : submitLabel}
          {draft.busy ? null : <ButtonShortcut keys="⌘↵" />}
        </Button>
      </div>
    </form>
  );
}
