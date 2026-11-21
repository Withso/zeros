import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button, ButtonShortcut } from "@/renderer/shared/ui/primitives";
import { Popover, PopoverAnchor, PopoverContent } from "@/renderer/shared/ui/primitives/popover";
import { toast } from "@/renderer/shared/ui/primitives/elements";
import { useWorkspaceDispatch, useWorkspaceStore } from "@/renderer/state/store";
import { formatLineReference, readCodeSelection, type CodeSelection } from "./code-selection";

let appendCounter = 0;
const OFF_SCREEN = new DOMRect(-10_000, -10_000, 0, 0);

const sameLines = (a: CodeSelection | null, b: CodeSelection | null) =>
  a === b || (!!a && !!b && a.start === b.start && a.end === b.end && a.removed === b.removed);

const isAddToChatKey = (event: KeyboardEvent) =>
  (event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "l";

/** "Add to Chat ⌘L" above a code selection in `root`: the source editor or a
 *  rendered diff. Adds a `path:L20-22` reference to the active chat's
 *  composer. */
export function AddToChatPopup({
  root,
  active,
  path,
}: {
  root: HTMLElement | null;
  active: boolean;
  path: string;
}) {
  const dispatch = useWorkspaceDispatch();
  const [selection, setSelection] = useState<CodeSelection | null>(null);
  // Added or dismissed lines stay hidden only until that selection ends.
  const [dismissed, setDismissed] = useState<{ path: string; lines: CodeSelection } | null>(null);
  const shown =
    selection && !(dismissed?.path === path && sameLines(selection, dismissed.lines)) ? selection : null;
  const latest = useRef({ shown, path, root });
  latest.current = { shown, path, root };
  const content = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!active || !root) {
      setSelection(null);
      return;
    }
    let frame = 0;
    let pointerDown = false;
    const read = () => {
      frame = 0;
      if (pointerDown) return;
      const next = readCodeSelection(root);
      if (!next) setDismissed(null);
      setSelection((current) => (sameLines(current, next) ? current : next));
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(read);
    };
    // The popup waits for the drag to finish instead of chasing the pointer.
    const down = (event: PointerEvent) => {
      if (content.current?.contains(event.target as Node)) return;
      pointerDown = true;
      setSelection(null);
      setDismissed(null);
    };
    const up = () => {
      if (!pointerDown) return;
      pointerDown = false;
      schedule();
    };
    document.addEventListener("selectionchange", schedule);
    root.addEventListener("pointerdown", down, true);
    root.addEventListener("focusout", schedule);
    document.addEventListener("pointerup", up, true);
    schedule();
    return () => {
      if (frame) cancelAnimationFrame(frame);
      document.removeEventListener("selectionchange", schedule);
      root.removeEventListener("pointerdown", down, true);
      root.removeEventListener("focusout", schedule);
      document.removeEventListener("pointerup", up, true);
    };
  }, [active, root]);

  const add = useCallback(() => {
    const { shown: current, path: file } = latest.current;
    if (!current) return;
    setDismissed({ path: file, lines: current });
    const chatId = useWorkspaceStore.getState().activeChatId;
    if (!chatId) {
      toast.error("No active chat to add this to.", { description: "Open or create a chat first." });
      return;
    }
    appendCounter += 1;
    dispatch({
      type: "ENQUEUE_COMPOSER_APPEND",
      append: {
        id: `code-reference-${appendCounter}`,
        text: formatLineReference(file, current),
        chatId,
        source: "manual",
        preserveFocus: true,
      },
    });
  }, [dispatch]);

  // Off screen once the selection scrolls out of the viewer, so
  // hideWhenDetached hides the popup instead of leaving it behind.
  const anchorRect = useCallback(() => {
    const rect = latest.current.shown?.rect();
    const bounds = latest.current.root?.getBoundingClientRect();
    return rect && bounds && rect.bottom > bounds.top && rect.top < bounds.bottom ? rect : OFF_SCREEN;
  }, []);

  // Capture so the editors' own Mod-L (CodeMirror selects a line) never runs.
  useEffect(() => {
    if (!active || !root || !shown) return;
    const keydown = (event: KeyboardEvent) => {
      // A selection scrolled out of view leaves ⌘L to the editor.
      if (!isAddToChatKey(event) || anchorRect() === OFF_SCREEN) return;
      event.preventDefault();
      event.stopPropagation();
      add();
    };
    root.addEventListener("keydown", keydown, true);
    return () => root.removeEventListener("keydown", keydown, true);
  }, [active, root, shown, add, anchorRect]);

  const anchor = useMemo(() => ({ current: { getBoundingClientRect: anchorRect } }), [anchorRect]);

  return (
    <Popover open={!!shown} onOpenChange={(open) => { if (!open && selection) setDismissed({ path, lines: selection }); }}>
      <PopoverAnchor virtualRef={anchor} />
      <PopoverContent
        ref={content}
        side="top"
        align="start"
        size="fit"
        padding="inset"
        hideWhenDetached
        updatePositionStrategy="always"
        data-add-to-chat=""
        // The selection's editor keeps focus, so ⌘L and typing still reach it.
        onOpenAutoFocus={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => event.preventDefault()}
        onFocusOutside={(event) => event.preventDefault()}
      >
        <Button
          variant="ghost"
          size="compact"
          aria-keyshortcuts="Meta+L Control+L"
          onPointerDown={(event) => event.preventDefault()}
          onClick={add}
        >
          Add to Chat
          <ButtonShortcut keys="⌘L" />
        </Button>
      </PopoverContent>
    </Popover>
  );
}
