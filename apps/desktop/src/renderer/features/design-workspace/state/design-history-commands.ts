export type DesignHistoryDirection = "undo" | "redo";
interface HistoryOwner {
  workspaceId: string;
  root: Element;
  isCurrent(): boolean;
  run(direction: DesignHistoryDirection): void;
}

function element(target: EventTarget | null): Element | null {
  return target && "nodeType" in target && target.nodeType === 1 ? target as Element : null;
}

function textField(target: EventTarget | null): Element | null {
  return element(target)?.closest('input, textarea, [role="textbox"]') ?? null;
}

/** Anywhere a key press is text: single-key shortcuts stay out of these. */
export function isDesignTextEntryTarget(target: EventTarget | null): boolean {
  if (textField(target)) return true;
  const editable = element(target)?.closest("[contenteditable]");
  return !!(editable && editable.getAttribute("contenteditable") !== "false");
}

export function isNativeHistoryTarget(target: EventTarget | null): boolean {
  // A Style field showing its committed value has no text history of its own:
  // Command-Z there belongs to the design, not to an empty native undo.
  if (textField(target)?.getAttribute("data-design-draft") === "clean") return false;
  return isDesignTextEntryTarget(target);
}

/** Only mounted active surfaces register. Pointer intent covers canvas clicks
 * that leave body focused, never a text field or another focused feature. */
export class DesignHistoryCommands {
  private owners = new Map<Element, HistoryOwner>();
  private pointerOwner: Element | null = null;
  private stepListeners = new Set<() => void>();
  constructor(private document: Document) {}

  private eligible(owner: HistoryOwner): boolean {
    return owner.root.isConnected && owner.isCurrent() &&
      !owner.root.closest('[inert], [hidden]');
  }

  private ownerAt(target: Element | null): HistoryOwner | undefined {
    if (!target || target.closest('[inert], [hidden], [aria-hidden="true"], [data-design-agent-activity]')) return;
    const portalOwner = target.closest("[data-design-history-owner]")?.getAttribute("data-design-history-owner");
    for (const owner of this.owners.values())
      if (this.eligible(owner) && (owner.root.contains(target) || portalOwner === owner.workspaceId)) return owner;
  }

  private remember = (event: Event) => {
    this.pointerOwner = this.ownerAt(element(event.target))?.root ?? null;
  };

  /** React events from a portal still traverse its owning Design root. Mark
   * that actual menu/popover on focus or pointer intent, before any shortcut.
   * Native DOM containment alone cannot identify these portaled descendants. */
  claimPortal(workspaceId: string, root: Element, target: EventTarget | null): void {
    const owner = this.owners.get(root);
    const node = element(target);
    if (!owner || owner.workspaceId !== workspaceId || !this.eligible(owner) || !node || root.contains(node)) return;
    const portal = node.closest('[role="menu"], [role="listbox"], [role="dialog"]');
    if (!portal || portal.closest('[aria-modal="true"], [data-design-review], [data-design-agent-activity]')) return;
    portal.setAttribute("data-design-history-owner", workspaceId);
    this.pointerOwner = root;
  }

  register(owner: HistoryOwner): () => void {
    if (!this.owners.size) {
      this.document.addEventListener("pointerdown", this.remember, true);
      this.document.addEventListener("focusin", this.remember, true);
    }
    this.owners.set(owner.root, owner);
    return () => {
      if (this.owners.get(owner.root) !== owner) return;
      this.owners.delete(owner.root);
      if (this.pointerOwner === owner.root) this.pointerOwner = null;
      if (!this.owners.size) {
        this.document.removeEventListener("pointerdown", this.remember, true);
        this.document.removeEventListener("focusin", this.remember, true);
      }
    };
  }

  private focused(allowEditable = false): HistoryOwner | undefined {
    if (this.document.visibilityState === "hidden" || this.document.querySelector(
      '[aria-modal="true"], dialog[open], [data-design-review][data-state="open"]',
    )) return;
    const target = this.document.activeElement;
    if (!allowEditable && isNativeHistoryTarget(target)) return;
    if (target && target !== this.document.body) return this.ownerAt(target);
    const owner = this.pointerOwner ? this.owners.get(this.pointerOwner) : undefined;
    return owner && this.eligible(owner) ? owner : undefined;
  }

  ownsFocus(workspaceId: string, allowEditable = false): boolean {
    return this.focused(allowEditable)?.workspaceId === workspaceId;
  }

  dispatch(direction: DesignHistoryDirection): boolean {
    const owner = this.focused();
    if (!owner) return false;
    for (const listener of this.stepListeners) listener();
    owner.run(direction);
    return true;
  }

  /** Told just before an undo or redo runs, so a focused field or an open
   * editor that holds back outside values can show what the step leaves. */
  onStep(listener: () => void): () => void {
    this.stepListeners.add(listener);
    return () => { this.stepListeners.delete(listener); };
  }
}

const documents = new WeakMap<Document, DesignHistoryCommands>();
function commands(document: Document): DesignHistoryCommands {
  let value = documents.get(document);
  if (!value) documents.set(document, (value = new DesignHistoryCommands(document)));
  return value;
}
export function registerDesignHistoryCommand(owner: HistoryOwner): () => void {
  return commands(owner.root.ownerDocument).register(owner);
}
export function markDesignHistoryPortal(workspaceId: string, root: Element, target: EventTarget | null): void {
  commands(root.ownerDocument).claimPortal(workspaceId, root, target);
}
export function isDesignHistoryFocusOwner(workspaceId: string, allowEditable = false): boolean {
  return typeof document !== "undefined" && commands(document).ownsFocus(workspaceId, allowEditable);
}
export function dispatchFocusedDesignHistory(direction: DesignHistoryDirection): boolean {
  return typeof document !== "undefined" && commands(document).dispatch(direction);
}
export function subscribeDesignHistorySteps(listener: () => void): () => void {
  return typeof document === "undefined" ? () => {} : commands(document).onStep(listener);
}
