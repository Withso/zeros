import { undo, redo } from "@codemirror/commands";
import { EditorView } from "@codemirror/view";
import type { Editor } from "@tiptap/core";

export type EditHistoryDirection = "undo" | "redo";
type HistoryHandler = (direction: EditHistoryDirection, target: Element) => boolean;
const owners = new WeakMap<Element, HistoryHandler>();

/** Custom surfaces claim their own history, including when its stack is empty. */
export function registerEditHistory(root: Element, handler: HistoryHandler): () => void {
  owners.set(root, handler);
  return () => { if (owners.get(root) === handler) owners.delete(root); };
}

function parent(element: Element): Element | null {
  return element.parentElement ?? (element.getRootNode() as ShadowRoot).host ?? null;
}

function visible(element: Element): boolean {
  for (let node: Element | null = element; node; node = parent(node)) {
    if (node.matches('[inert], [hidden], [aria-hidden="true"]')) return false;
  }
  return element.isConnected && element.getClientRects().length > 0;
}

export function isNativeEditHistoryTarget(target: Element): boolean {
  return target.matches("input, textarea") && !target.closest(".xterm");
}

/** Shadow editors expose their input inside the shadow root, not activeElement. */
function focusedElement(doc: Document): Element | null {
  let target = doc.activeElement;
  while (target?.shadowRoot?.activeElement) target = target.shadowRoot.activeElement;
  return target;
}

/** Blink's native stack belongs to the document: its next step may target a
 * different field. Undo in an empty search must not edit a commit message. */
export function preventUnfocusedEditHistory(event: Event): void {
  const input = event as InputEvent;
  if (input.inputType !== "historyUndo" && input.inputType !== "historyRedo") return;
  const target = input.composedPath()[0];
  if (!(target instanceof Element)) return;
  const doc = target.ownerDocument;
  if (doc.visibilityState === "hidden" || focusedElement(doc) !== target || !visible(target))
    input.preventDefault();
}

export function dispatchFocusedEditHistory(
  direction: EditHistoryDirection,
  doc: Document = document,
): "handled" | "native" | "none" {
  if (doc.visibilityState === "hidden" || !doc.hasFocus()) return "none";
  const target = focusedElement(doc);
  if (!target || !visible(target)) return "none";
  const path: Element[] = [];
  for (let node: Element | null = target; node; node = parent(node)) path.push(node);
  const modal = Array.from(doc.querySelectorAll('[aria-modal="true"], dialog[open]'))
    .find(element => visible(element) && !path.some(node => element.contains(node)));
  if (modal) return "none";

  for (const node of path) {
    if (owners.get(node)?.(direction, target)) return "handled";
  }

  const view = EditorView.findFromDOM(target as HTMLElement);
  if (view?.contentDOM.contains(target)) {
    // Native Undo can target another field's Blink undo step. Never fall back
    // from an empty or read-only custom history to that unrelated document.
    if (!view.state.readOnly && view.state.facet(EditorView.editable))
      (direction === "undo" ? undo : redo)(view);
    return "handled";
  }

  if (!isNativeEditHistoryTarget(target)) {
    const element = path.find(node => node.classList.contains("ProseMirror"));
    // TipTap attaches its owning Editor to the real ProseMirror view DOM.
    const editor = (element as (HTMLElement & { editor?: Editor }) | undefined)?.editor;
    if (editor && !editor.isDestroyed && editor.view.dom === element) {
      if (editor.isEditable && typeof editor.commands[direction] === "function") editor.commands[direction]();
      return "handled";
    }
  }

  const nativeContentEditable = target.matches('[contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"]') &&
    !target.closest(".xterm");
  return (isNativeEditHistoryTarget(target) && !target.matches(":disabled, [readonly]")) ||
    nativeContentEditable || target.matches("iframe, webview") ? "native" : "none";
}

export function editHistoryKey(event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey" | "isComposing">): EditHistoryDirection | null {
  if (event.isComposing || event.altKey || !(event.metaKey || event.ctrlKey)) return null;
  if (event.key.toLowerCase() === "z") return event.shiftKey ? "redo" : "undo";
  return event.ctrlKey && !event.metaKey && !event.shiftKey && event.key.toLowerCase() === "y" ? "redo" : null;
}
