import { useCallback, useEffect, useMemo, useRef, useState, type FocusEvent as ReactFocusEvent, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { MessageSquarePlus, Reply } from "lucide-react";
import {
  Button,
  ButtonShortcut,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuShortcut,
  SplitButton,
  Textarea,
} from "@/renderer/shared/ui/primitives";
import { Popover, PopoverAnchor, PopoverContent } from "@/renderer/shared/ui/primitives/popover";
import { toast } from "@/renderer/shared/ui/primitives/elements";
import type { AttachmentValidation } from "./agent-attachments";
import {
  CHAT_REPLY_SOURCE,
  CHAT_SELECTION_SOURCE,
  chatAttachmentName,
  placePopup,
  POPUP_EDGE,
  previewText,
  rangeStillSelects,
  readChatSelection,
  type ChatSelection,
  type Placement,
} from "./chat-selection";
import "./chat-selection.css";

type StageText = (
  input: { sourceKey: string; name: string; text: string; label?: string },
  options?: { focus?: boolean; atEnd?: boolean },
) => AttachmentValidation | null;

/** Stage selected text, or a reply with its quote, as a `.txt` pill in the
 *  composer. Each gets its own key and file, and the pill shows `label`. */
export function stageChatText(stage: StageText, kind: "selection" | "reply", text: string, label: string): boolean {
  const name = chatAttachmentName(kind);
  const staged = stage({
    sourceKey: `${kind === "selection" ? CHAT_SELECTION_SOURCE : CHAT_REPLY_SOURCE}${crypto.randomUUID()}`,
    name,
    text,
    label: previewText(label, 120),
  }, { atEnd: true });
  if (!staged) {
    toast.error("Couldn't add that to the chat.", { description: "The message box isn't available right now." });
    return false;
  }
  if (!staged.ok) {
    toast.warning(`Added "${name}", but it won't be sent — ${staged.reason ?? "it exceeds this model's attachment budget"}.`);
  }
  return true;
}

const OFF_SCREEN = new DOMRect(-10_000, -10_000, 0, 0);
const HIGHLIGHT = "zeros-chat-reply";

const isAddToChatKey = (event: KeyboardEvent) =>
  (event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "l";

const isEditableTarget = (target: EventTarget | null) =>
  target instanceof Element && !!target.closest("input, textarea, select, [contenteditable]:not([contenteditable='false'])");

const sameSelection = (a: ChatSelection | null, b: ChatSelection | null) =>
  a === b ||
  (!!a && !!b && a.text === b.text &&
    a.range.startContainer === b.range.startContainer && a.range.startOffset === b.range.startOffset &&
    a.range.endContainer === b.range.endContainer && a.range.endOffset === b.range.endOffset);

type HighlightRegistry = { set(name: string, value: unknown): void; delete(name: string): void };
type HighlightConstructor = new (...ranges: Range[]) => unknown;

/** Keeps the replied-to text highlighted while the reply field holds the
 *  document's selection. */
function useReplyHighlight(range: Range | null) {
  useEffect(() => {
    const registry = (globalThis.CSS as { highlights?: HighlightRegistry } | undefined)?.highlights;
    const Highlight = (globalThis as { Highlight?: HighlightConstructor }).Highlight;
    if (!range || !registry || !Highlight) return;
    registry.set(HIGHLIGHT, new Highlight(range));
    return () => registry.delete(HIGHLIGHT);
  }, [range]);
}

function visibleBounds(root: HTMLElement): DOMRect {
  const rect = root.getBoundingClientRect();
  const view = root.ownerDocument.documentElement;
  const top = Math.max(rect.top, 0);
  const left = Math.max(rect.left, 0);
  const right = Math.min(rect.right, view.clientWidth);
  const bottom = Math.min(rect.bottom, view.clientHeight);
  return new DOMRect(left, top, Math.max(0, right - left), Math.max(0, bottom - top));
}

export interface ChatSelectionPopupProps {
  /** The transcript scroller. */
  root: HTMLElement | null;
  /** The chat is the visible, editable surface. */
  active: boolean;
  /** The chat is the selected one, which owns typing. A split workspace shows
   *  two active chats, and only this one may take focus back. Defaults to
   *  `active`. */
  ownsKeyboard?: boolean;
  /** Stage the text as a pill; false when nothing was staged. */
  onAddSelection: (text: string) => boolean;
  onAddReply: (quote: string, reply: string) => boolean;
  /** Send now. The reply stays open, busy, until this settles, and stays
   *  open with its text when it resolves false (the send was refused). */
  onSendReply: (quote: string, reply: string) => boolean | Promise<boolean>;
}

/** "Add to chat ⌘L · Reply" over text selected anywhere in the transcript:
 *  user and agent messages, thinking, tool output and between them. Reply
 *  turns the same popup into a field under a two-line quote of the text. */
export function ChatSelectionPopup({ root, active, ownsKeyboard = active, onAddSelection, onAddReply, onSendReply }: ChatSelectionPopupProps) {
  const [selection, setSelection] = useState<ChatSelection | null>(null);
  // Hidden by Esc, an outside click or an action until the selection changes.
  const [dismissed, setDismissed] = useState<ChatSelection | null>(null);
  const [reply, setReply] = useState<ChatSelection | null>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  // Hidden while the chat is, but a reply keeps its quote and text for when
  // the chat comes back.
  const shown = active ? reply ?? (selection && !sameSelection(selection, dismissed) ? selection : null) : null;
  const content = useRef<HTMLDivElement | null>(null);
  const field = useRef<HTMLTextAreaElement | null>(null);
  const placement = useRef<Placement["side"] | null>(null);
  const latest = useRef({ shown, reply, root, draft, sending, onAddSelection, onAddReply, onSendReply });
  latest.current = { shown, reply, root, draft, sending, onAddSelection, onAddReply, onSendReply };

  useReplyHighlight(active ? reply?.range ?? null : null);

  const closeReply = useCallback(() => {
    setReply(null);
    setDraft("");
    setSending(false);
    placement.current = null;
  }, []);

  useEffect(() => {
    if (active && root) return;
    setSelection(null);
    setDismissed(null);
    if (!root) closeReply();
  }, [active, root, closeReply]);

  // The popup waits for a drag to end instead of chasing the pointer, and
  // ignores the selection while a reply owns it. The listeners stay attached
  // through a reply, so a press that closes it still counts as a drag.
  const readSoon = useRef<() => void>(() => {});
  useEffect(() => {
    if (!active || !root) return;
    let frame = 0;
    let pointerDown = false;
    const read = () => {
      frame = 0;
      if (pointerDown || latest.current.reply) return;
      const next = readChatSelection(root);
      if (!next) setDismissed(null);
      setSelection((current) => (sameSelection(current, next) ? current : next));
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(read);
    };
    readSoon.current = schedule;
    const down = (event: PointerEvent) => {
      if (event.button !== 0) return;
      pointerDown = true;
      setSelection(null);
      setDismissed(null);
    };
    const up = () => {
      if (!pointerDown) return;
      pointerDown = false;
      schedule();
    };
    const doc = root.ownerDocument;
    doc.addEventListener("selectionchange", schedule);
    root.addEventListener("pointerdown", down, true);
    doc.addEventListener("pointerup", up, true);
    doc.addEventListener("pointercancel", up, true);
    schedule();
    return () => {
      if (frame) cancelAnimationFrame(frame);
      readSoon.current = () => {};
      doc.removeEventListener("selectionchange", schedule);
      root.removeEventListener("pointerdown", down, true);
      doc.removeEventListener("pointerup", up, true);
      doc.removeEventListener("pointercancel", up, true);
    };
  }, [active, root]);
  useEffect(() => {
    if (!reply) readSoon.current();
  }, [reply]);

  // Read every frame while open, so the popup follows scrolling, streaming
  // text and pane resizes; a selection scrolled away hides it, except while a
  // reply is being typed, which rests at the nearer edge of the view instead.
  const anchorRect = useCallback(() => {
    const { shown: target, reply: replying, root: scroller } = latest.current;
    if (!target || !scroller) return OFF_SCREEN;
    const live = rangeStillSelects(target.range);
    if (!live && !replying) return OFF_SCREEN;
    const bounds = visibleBounds(scroller);
    const element = content.current;
    // The transcript bounds the popup, not the window. Written only on change:
    // a style write every frame would force a layout every frame.
    if (element) {
      const width = `${Math.max(0, bounds.width - POPUP_EDGE * 2)}px`;
      const height = `${Math.max(0, bounds.height - POPUP_EDGE * 2)}px`;
      if (element.style.getPropertyValue("--chat-selection-max-width") !== width)
        element.style.setProperty("--chat-selection-max-width", width);
      if (element.style.getPropertyValue("--chat-selection-max-height") !== height)
        element.style.setProperty("--chat-selection-max-height", height);
    }
    const next = placePopup({
      // A reply whose text left the DOM (older history paged out) keeps its
      // quote and rests at the top of the view.
      selection: live ? target.range.getBoundingClientRect() : { top: bounds.top - 2, bottom: bounds.top - 1, left: bounds.left, right: bounds.right },
      bounds,
      width: element?.offsetWidth ?? 0,
      height: element?.offsetHeight ?? 0,
      pin: !!replying,
      previous: placement.current,
    });
    if (!next) return OFF_SCREEN;
    placement.current = next.side;
    return new DOMRect(next.x, next.y, 0, 0);
  }, []);
  const anchor = useMemo(() => ({ current: { getBoundingClientRect: anchorRect } }), [anchorRect]);

  const addSelection = useCallback(() => {
    const target = latest.current.shown;
    if (!target || latest.current.reply) return;
    // A failed stage leaves the bar up, so the same selection can be retried.
    if (latest.current.onAddSelection(target.text)) setDismissed(target);
  }, []);

  const startReply = useCallback(() => {
    const target = latest.current.shown;
    if (!target) return;
    placement.current = null;
    setDraft("");
    setReply(target);
  }, []);

  const submitReply = useCallback(async (send: boolean) => {
    const { reply: target, draft: text, sending: busy, onSendReply: sendReply, onAddReply: addReply } = latest.current;
    if (!target || !text.trim() || busy) return;
    let done: boolean;
    if (send) {
      setSending(true);
      try {
        done = await sendReply(target.text, text);
      } catch {
        done = false;
      }
      // Closed, or replaced by another reply, while the send was prepared.
      if (latest.current.reply !== target) return;
      setSending(false);
    } else {
      done = addReply(target.text, text);
    }
    if (!done) return;
    setDismissed(target);
    closeReply();
  }, [closeReply]);

  // The field takes focus when Reply opens it, and again when its chat comes
  // back, unless the user had since moved on to something else in the chat.
  const fieldOwnsFocus = useRef(false);
  useEffect(() => {
    if (!reply) {
      fieldOwnsFocus.current = false;
      return;
    }
    fieldOwnsFocus.current = true;
  }, [reply]);
  useEffect(() => {
    if (!active || !ownsKeyboard || !reply || !fieldOwnsFocus.current) return;
    // The content mounts in a portal on the open render.
    const frame = requestAnimationFrame(() => {
      const element = field.current;
      if (!element) return;
      element.focus({ preventScroll: true });
      element.setSelectionRange(element.value.length, element.value.length);
    });
    return () => cancelAnimationFrame(frame);
  }, [active, ownsKeyboard, reply]);
  const fieldBlur = (event: ReactFocusEvent<HTMLTextAreaElement>) => {
    const to = event.relatedTarget;
    const surface = root?.closest("[data-zeros-root]") ?? root;
    // Leaving for the composer or another control in this chat is a choice;
    // a press outside the chat (a tab, another pane) is a switch, and the
    // popup's own buttons keep the reply in hand.
    if (to instanceof Node && surface?.contains(to) && !content.current?.contains(to)) fieldOwnsFocus.current = false;
  };

  // ⌘L adds the selection. Capture, so an editor's own Mod-L never runs, and
  // only while the popup shows: a field elsewhere keeps its own selection.
  useEffect(() => {
    if (!active || !root || !shown || reply) return;
    const keydown = (event: KeyboardEvent) => {
      if (!isAddToChatKey(event) || isEditableTarget(event.target) || anchorRect() === OFF_SCREEN) return;
      event.preventDefault();
      event.stopPropagation();
      addSelection();
    };
    const doc = root.ownerDocument;
    doc.addEventListener("keydown", keydown, true);
    return () => doc.removeEventListener("keydown", keydown, true);
  }, [active, root, shown, reply, addSelection, anchorRect]);

  const fieldKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey || event.altKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    void submitReply(event.metaKey || event.ctrlKey);
  };

  const close = () => {
    const target = reply ?? selection;
    if (target) setDismissed(target);
    if (reply) closeReply();
  };
  const empty = !draft.trim();

  return (
    <Popover open={!!shown} onOpenChange={(open) => { if (!open) close(); }}>
      <PopoverAnchor virtualRef={anchor} />
      <PopoverContent
        ref={content}
        side="bottom"
        align="start"
        sideOffset={0}
        // placePopup owns the edges and the side. Radix's own padding would
        // mark a point anchored on that edge as clipped and hide the popup.
        avoidCollisions={false}
        collisionPadding={0}
        size={reply ? "lg" : "fit"}
        padding={reply ? "default" : "inset"}
        hideWhenDetached
        updatePositionStrategy="always"
        data-chat-selection-popup={reply ? "reply" : "actions"}
        className="flex max-h-(--chat-selection-max-height) max-w-(--chat-selection-max-width) flex-col overflow-hidden"
        // The selection keeps its focus until Reply moves it to the field.
        onOpenAutoFocus={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => event.preventDefault()}
        onFocusOutside={(event) => event.preventDefault()}
        // A typed reply survives a stray click; Esc or sending closes it.
        onPointerDownOutside={(event) => {
          // A press in the transcript starts the next selection, which the
          // reader above already handles.
          const pressedTranscript = event.target instanceof Node && !!root?.contains(event.target);
          if ((reply && !empty) || (!reply && pressedTranscript)) event.preventDefault();
        }}
      >
        {reply ? (
          <div className="flex min-h-0 flex-col gap-2">
            <blockquote
              data-chat-reply-quote=""
              className="border-border3 text-fg3 line-clamp-2 shrink-0 border-l-2 pl-2 text-xs wrap-anywhere"
            >
              {previewText(reply.text)}
            </blockquote>
            <div className="flex min-h-0 items-end gap-2">
              <Textarea
                ref={field}
                appearance="bare"
                rows={1}
                value={draft}
                readOnly={sending}
                placeholder="Reply…"
                aria-label="Reply"
                aria-keyshortcuts="Enter Meta+Enter Control+Enter"
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={fieldKeyDown}
                onFocus={() => { fieldOwnsFocus.current = true; }}
                onBlur={fieldBlur}
                className="max-h-60 min-h-0 flex-1 self-stretch"
              />
              <SplitButton
                size="compact"
                variant="primary"
                className="shrink-0"
                disabled={empty}
                loading={sending}
                onClick={() => void submitReply(false)}
                menuLabel="More ways to reply"
                menu={
                  <DropdownMenuContent align="end" side="bottom">
                    <DropdownMenuItem disabled={empty || sending} onSelect={() => void submitReply(true)}>
                      Send immediately
                      <DropdownMenuShortcut>⌘↵</DropdownMenuShortcut>
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                }
              >
                Add to chat
              </SplitButton>
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-0.5">
            <Button
              variant="ghost"
              size="compact"
              aria-keyshortcuts="Meta+L Control+L"
              onPointerDown={(event) => event.preventDefault()}
              onClick={addSelection}
            >
              <MessageSquarePlus />
              Add to chat
              <ButtonShortcut keys="⌘L" />
            </Button>
            <Button
              variant="ghost"
              size="compact"
              onPointerDown={(event) => event.preventDefault()}
              onClick={startReply}
            >
              <Reply />
              Reply
            </Button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
