import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { CODE_REVIEW_BODY_LIMIT } from "@zeros/protocol/code-review";
import { Button, Textarea } from "@/renderer/shared/ui/primitives";
import type { ReviewDraftStore } from "./review-draft-store";

export function ReviewComposer({
  store,
  draftKey,
  label,
  submitLabel = "Comment",
  active,
  onSubmit,
  onCancel,
  onSubmitted,
  children,
}: {
  store: ReviewDraftStore;
  draftKey: string;
  label: string;
  submitLabel?: string;
  active: boolean;
  onSubmit: (body: string, requestId: string) => Promise<void>;
  onCancel: () => void;
  onSubmitted?: () => void;
  children?: ReactNode;
}) {
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
      className="flex min-w-0 flex-col gap-2 font-sans"
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
      <label htmlFor={id} className="text-fg2 text-xs font-medium">
        {label}
      </label>
      {children}
      <Textarea
        ref={textarea}
        id={id}
        aria-describedby={draft.error ? `${id}-error` : undefined}
        value={draft.body}
        maxLength={CODE_REVIEW_BODY_LIMIT}
        rows={3}
        placeholder="Write a comment…"
        className="bg-bg1 min-h-16 resize-y px-2 py-1.5 text-xs leading-relaxed shadow-none"
        disabled={!active}
        onChange={(event) => store.setBody(draftKey, event.target.value)}
      />
      {draft.error && (
        <p
          id={`${id}-error`}
          role="alert"
          className="text-red-primary text-xs break-words"
        >
          {draft.error}
        </p>
      )}
      <div className="flex items-center justify-end gap-1">
        <span className="text-fg3 mr-auto text-xs">⌘/Ctrl + Enter</span>
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
          disabled={draft.busy || !draft.body.trim() || !active}
          aria-label={submitLabel}
        >
          {draft.busy ? "Sending…" : submitLabel}
        </Button>
      </div>
    </form>
  );
}
