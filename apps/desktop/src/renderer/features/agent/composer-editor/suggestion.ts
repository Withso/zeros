// ──────────────────────────────────────────────────────────
// suggestion.ts — @ / slash / # triggers on a TipTap Suggestion bridge
// ──────────────────────────────────────────────────────────
//
// Three independent ProseMirror Suggestion plugins (one per trigger char,
// each with a UNIQUE PluginKey — same-key plugins collide and only one menu
// would ever show). Instead of tippy/floating-ui, every plugin's render()
// pushes its live state into a small per-editor store; a sibling React popup
// (suggestion-popup.tsx) subscribes and renders the EXISTING pickers
// (MentionPicker / SlashCommandPicker / PrPicker). File/command suggestions
// use the active trigger's coordinates. onKeyDown forwards keys and returns a boolean
// so ProseMirror knows whether the key was consumed.
//
// items() + command() are passed in by the hook as stable closures that read
// refs, so the editor is created once yet always sees current files / slash
// commands / PRs / handlers.
// ──────────────────────────────────────────────────────────

import { Extension } from "@tiptap/core";
import type { Editor, Range } from "@tiptap/core";
import Suggestion, {
  exitSuggestion,
  type SuggestionKeyDownProps,
  type SuggestionProps,
} from "@tiptap/suggestion";
import { PluginKey } from "@tiptap/pm/state";
import { shallow } from "zustand/shallow";

import type { MentionItem } from "../mentions";
import type { AvailableCommand } from "../../../platform/bridge/agent-events";
import type { PrPickerItem } from "../pr-picker";

export type SuggestionTrigger = "@" | "/" | "#";

export type SuggestionItem = MentionItem | AvailableCommand | PrPickerItem;

function suggestionIdentity(item: SuggestionItem): string {
  if ("id" in item) return item.id;
  if ("number" in item) return `pr:${item.number}`;
  return `command:${item.kind ?? "command"}:${item.name}`;
}

/** Slash-picker category tabs. */
export type SlashTab = "all" | "commands" | "skills";

/** Whether a slash item belongs in the given tab. Items with no `kind` are
 *  treated as commands (the conservative default). */
export function matchesSlashTab(item: AvailableCommand, tab: SlashTab): boolean {
  if (tab === "all") return true;
  const kind = item.kind ?? "command";
  return tab === "skills" ? kind === "skill" : kind === "command";
}

/** Load state of the trigger's data source — lets the popup show a real
 *  "Loading…" / "Couldn't load…" message instead of silently not appearing
 *  (or conflating "fetch failed" with "genuinely empty"). The "/" trigger is
 *  synchronous, so it is always "ready". */
export type SuggestionStatus = "loading" | "ready" | "error";

export interface SuggestionAnchor {
  element: HTMLElement;
  getBoundingClientRect: () => DOMRect;
  dismiss: () => void;
}

export interface SuggestionState {
  open: boolean;
  trigger: SuggestionTrigger;
  query: string;
  items: SuggestionItem[];
  status: SuggestionStatus;
  selectedIndex: number;
  command: ((item: SuggestionItem) => void) | null;
  /** Active "/" category tab. Ignored for the @ / # triggers. */
  slashTab: SlashTab;
  anchor: SuggestionAnchor | null;
}

const EMPTY_STATE: SuggestionState = {
  open: false,
  trigger: "@",
  query: "",
  items: [],
  status: "ready",
  selectedIndex: 0,
  command: null,
  slashTab: "all",
  anchor: null,
};

/** Per-editor external store the popup subscribes to via useSyncExternalStore. */
export class SuggestionStore {
  private state: SuggestionState = EMPTY_STATE;
  private listeners = new Set<() => void>();

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };

  getSnapshot = (): SuggestionState => this.state;

  private set(patch: Partial<SuggestionState>): void {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((l) => l());
  }

  open(
    trigger: SuggestionTrigger,
    props: {
      query: string;
      items: SuggestionItem[];
      status: SuggestionStatus;
      command: (item: SuggestionItem) => void;
      anchor?: SuggestionAnchor;
    },
  ): void {
    this.set({
      open: true,
      trigger,
      query: props.query,
      items: props.items,
      status: props.status,
      command: props.command,
      anchor: props.anchor ?? null,
      selectedIndex: 0,
      // A freshly-opened "/" menu always starts on All.
      slashTab: "all",
    });
  }

  update(props: {
    query: string;
    items: SuggestionItem[];
    status: SuggestionStatus;
    command: (item: SuggestionItem) => void;
    anchor?: SuggestionAnchor;
  }): void {
    this.set({
      query: props.query,
      items: props.items,
      status: props.status,
      command: props.command,
      ...(props.anchor ? { anchor: props.anchor } : {}),
      // Reset highlight to the top whenever the list changes, like the
      // legacy pickers' clamp-to-0 effect.
      selectedIndex: 0,
    });
  }

  /** Re-push items + status into the already-open menu after an async load
   *  lands (file list / PR fetch), so "Loading…" flips to results/empty
   *  without the user having to type another character. */
  setData(props: { items: SuggestionItem[]; status: SuggestionStatus }): void {
    if (!this.state.open) return;
    const items =
      props.items.length === this.state.items.length &&
      props.items.every((item, i) => shallow(item, this.state.items[i]))
        ? this.state.items
        : props.items;
    if (items === this.state.items && props.status === this.state.status)
      return;
    const selected = this.slashVisible()[this.state.selectedIndex];
    const visible = this.slashVisible(items);
    const index = selected
      ? visible.findIndex(
          (item) => suggestionIdentity(item) === suggestionIdentity(selected),
        )
      : -1;
    // Background reads keep the user's choice, even if ranking moves it. Only
    // a changed query (update) or a newly opened menu resets to the first row.
    const selectedIndex =
      index >= 0
        ? index
        : Math.max(0, Math.min(this.state.selectedIndex, visible.length - 1));
    this.set({ items, status: props.status, selectedIndex });
  }

  /** The items actually visible given the active "/" tab. Navigation + choose
   *  operate on THIS list so `selectedIndex` always indexes what's rendered
   *  (the picker filters the same way via matchesSlashTab). */
  private slashVisible(items = this.state.items): SuggestionItem[] {
    const s = this.state;
    if (s.trigger !== "/" || s.slashTab === "all") return items;
    return items.filter((it) =>
      matchesSlashTab(it as AvailableCommand, s.slashTab),
    );
  }

  move(delta: number): void {
    const n = this.slashVisible().length;
    if (n === 0) return;
    this.set({ selectedIndex: (this.state.selectedIndex + delta + n) % n });
  }

  setIndex(i: number): void {
    if (i !== this.state.selectedIndex) this.set({ selectedIndex: i });
  }

  /** Switch the active "/" tab and re-home the highlight to the top. */
  setSlashTab(tab: SlashTab): void {
    if (tab !== this.state.slashTab) this.set({ slashTab: tab, selectedIndex: 0 });
  }

  /** Cycle the "/" tab (ArrowLeft/Right): all → commands → skills → all. */
  cycleSlashTab(delta: number): void {
    const order: SlashTab[] = ["all", "commands", "skills"];
    const i = order.indexOf(this.state.slashTab);
    this.setSlashTab(order[(i + delta + order.length) % order.length]);
  }

  /** Accept the highlighted item (Enter/Tab). */
  choose(): void {
    const item = this.slashVisible()[this.state.selectedIndex];
    if (item != null && this.state.command) this.state.command(item);
  }

  /** Accept a specific item (mouse click in the popup). */
  chooseItem(item: SuggestionItem): void {
    this.state.command?.(item);
  }

  get isOpen(): boolean {
    return this.state.open;
  }

  close(): void {
    if (this.state.open) this.set({ open: false, command: null, items: [], anchor: null });
  }

  dismiss(): void {
    // Close the ProseMirror trigger as well as its React surface. Otherwise
    // Escape leaves the plugin active and a later query can never reopen it.
    this.state.anchor?.dismiss();
    this.close();
  }
}

function makeRender(
  store: SuggestionStore,
  trigger: SuggestionTrigger,
  pluginKey: PluginKey,
  getStatus: (trigger: SuggestionTrigger) => SuggestionStatus,
  onOpen?: () => void,
) {
  const anchor = (props: SuggestionProps<SuggestionItem, SuggestionItem>): SuggestionAnchor => ({
    element: props.editor.view.dom,
    dismiss: () => { if (!props.editor.isDestroyed) exitSuggestion(props.editor.view, pluginKey); },
    getBoundingClientRect: () => {
      if (props.editor.isDestroyed) return new DOMRect();
      const from = props.editor.view.coordsAtPos(props.range.from);
      const to = props.editor.view.coordsAtPos(props.range.to);
      // A query may wrap. Keep its menu beside the line being edited rather
      // than above an earlier line or at the edge of the entire composer.
      const left = Math.abs(from.top - to.top) < 2 ? from.left : to.left;
      return new DOMRect(left, to.top, 0, to.bottom - to.top);
    },
  });
  return () => ({
    onStart: (props: SuggestionProps<SuggestionItem, SuggestionItem>) => {
      // Fire BEFORE store.open so a data-source that flips to "loading" (e.g.
      // the @-file list kicking a fresh read) is reflected in the first paint.
      onOpen?.();
      store.open(trigger, {
        query: props.query,
        items: props.items,
        status: getStatus(trigger),
        command: props.command,
        anchor: anchor(props),
      });
    },
    onUpdate: (props: SuggestionProps<SuggestionItem, SuggestionItem>) => {
      store.update({
        query: props.query,
        items: props.items,
        status: getStatus(trigger),
        command: props.command,
        anchor: anchor(props),
      });
    },
    onKeyDown: ({ event }: SuggestionKeyDownProps): boolean => {
      if (!store.isOpen) return false;
      switch (event.key) {
        case "ArrowDown":
          store.move(1);
          return true;
        case "ArrowUp":
          store.move(-1);
          return true;
        case "Enter":
        case "Tab":
          store.choose();
          return true;
        case "ArrowLeft":
          // Left/Right switch the "/" category tab (All/Commands/Skills). The
          // category tabs remain reachable without moving focus out of the editor.
          if (trigger === "/") {
            store.cycleSlashTab(-1);
            return true;
          }
          return false;
        case "ArrowRight":
          if (trigger === "/") {
            store.cycleSlashTab(1);
            return true;
          }
          return false;
        case "Escape":
          store.dismiss();
          return true;
        default:
          return false;
      }
    },
    onExit: () => store.close(),
  });
}

export interface ComposerSuggestionsOptions {
  store: SuggestionStore;
  getMentionItems: (query: string) => MentionItem[];
  getSlashItems: (query: string) => AvailableCommand[];
  getPrItems: (query: string) => PrPickerItem[];
  /** Load state of the active trigger's data source (drives loading/error UI). */
  getStatus: (trigger: SuggestionTrigger) => SuggestionStatus;
  /** Called when @ opens to revalidate stale results. File-change signals
   * invalidate the shared exact-key cache; async results refresh the open menu. */
  onMentionOpen: () => void;
  /** Prepare native session commands without submitting the draft. */
  onSlashOpen: () => void;
  prEnabled: () => boolean;
  onPickMention: (editor: Editor, range: Range, item: MentionItem) => void;
  onPickSlash: (editor: Editor, range: Range, item: AvailableCommand) => void;
  onPickPr: (editor: Editor, range: Range, item: PrPickerItem) => void;
}

const noop = () => {};

// priority 1100 → the Suggestion plugins' handleKeyDown runs BEFORE the
// ComposerKeymap (1000), so Enter accepts the highlighted item while a menu
// is open instead of submitting the message.
export const ComposerSuggestions = Extension.create<ComposerSuggestionsOptions>({
  name: "composerSuggestions",
  priority: 1100,

  addOptions() {
    return {
      store: new SuggestionStore(),
      getMentionItems: () => [],
      getSlashItems: () => [],
      getPrItems: () => [],
      getStatus: (): SuggestionStatus => "ready",
      onMentionOpen: noop,
      onSlashOpen: noop,
      prEnabled: () => false,
      onPickMention: noop,
      onPickSlash: noop,
      onPickPr: noop,
    };
  },

  addProseMirrorPlugins() {
    const o = this.options;
    const mentionKey = new PluginKey("composerMention");
    const slashKey = new PluginKey("composerSlash");
    const prKey = new PluginKey("composerPr");
    return [
      Suggestion<MentionItem, MentionItem>({
        editor: this.editor,
        char: "@",
        pluginKey: mentionKey,
        items: ({ query }) => o.getMentionItems(query),
        command: ({ editor, range, props }) =>
          o.onPickMention(editor, range, props),
        render: makeRender(o.store, "@", mentionKey, o.getStatus, o.onMentionOpen) as never,
      }),
      Suggestion<AvailableCommand, AvailableCommand>({
        editor: this.editor,
        char: "/",
        pluginKey: slashKey,
        startOfLine: false,
        allowedPrefixes: [" ", "\t", "\n"],
        allow: ({ state, range }) => !state.doc.textBetween(range.from + 1, range.to).includes("/"),
        items: ({ query }) => o.getSlashItems(query),
        command: ({ editor, range, props }) =>
          o.onPickSlash(editor, range, props),
        render: makeRender(o.store, "/", slashKey, o.getStatus, o.onSlashOpen) as never,
      }),
      Suggestion<PrPickerItem, PrPickerItem>({
        editor: this.editor,
        char: "#",
        pluginKey: prKey,
        allow: () => o.prEnabled(),
        items: ({ query }) => o.getPrItems(query),
        command: ({ editor, range, props }) =>
          o.onPickPr(editor, range, props),
        render: makeRender(o.store, "#", prKey, o.getStatus) as never,
      }),
    ];
  },
});
