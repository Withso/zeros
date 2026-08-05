// ──────────────────────────────────────────────────────────
// suggestion.ts — @ / slash / # triggers on a TipTap Suggestion bridge
// ──────────────────────────────────────────────────────────
//
// Three independent ProseMirror Suggestion plugins (one per trigger char,
// each with a UNIQUE PluginKey — same-key plugins collide and only one menu
// would ever show). Instead of tippy/floating-ui, every plugin's render()
// pushes its live state into a small per-editor store; a sibling React popup
// (suggestion-popup.tsx) subscribes and renders the EXISTING pickers
// (MentionPicker / SlashCommandPicker / PrPicker), self-positioned above the
// composer card. onKeyDown forwards arrow/enter/escape and returns a boolean
// so ProseMirror knows whether the key was consumed.
//
// items() + command() are passed in by the hook as stable closures that read
// refs, so the editor is created once yet always sees current files / slash
// commands / PRs / handlers.
// ──────────────────────────────────────────────────────────

import { Extension } from "@tiptap/core";
import type { Editor, Range } from "@tiptap/core";
import Suggestion, {
  type SuggestionKeyDownProps,
  type SuggestionProps,
} from "@tiptap/suggestion";
import { PluginKey } from "@tiptap/pm/state";

import type { MentionItem } from "../mentions";
import type { AvailableCommand } from "../../../platform/bridge/agent-events";
import type { PrPickerItem } from "../pr-picker";

export type SuggestionTrigger = "@" | "/" | "#";

export type SuggestionItem = MentionItem | AvailableCommand | PrPickerItem;

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
    },
  ): void {
    this.set({
      open: true,
      trigger,
      query: props.query,
      items: props.items,
      status: props.status,
      command: props.command,
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
  }): void {
    this.set({
      query: props.query,
      items: props.items,
      status: props.status,
      command: props.command,
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
    this.set({ items: props.items, status: props.status, selectedIndex: 0 });
  }

  /** The items actually visible given the active "/" tab. Navigation + choose
   *  operate on THIS list so `selectedIndex` always indexes what's rendered
   *  (the picker filters the same way via matchesSlashTab). */
  private slashVisible(): SuggestionItem[] {
    const s = this.state;
    if (s.trigger !== "/" || s.slashTab === "all") return s.items;
    return s.items.filter((it) =>
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
    if (this.state.open) this.set({ open: false, command: null, items: [] });
  }
}

function makeRender(
  store: SuggestionStore,
  trigger: SuggestionTrigger,
  getStatus: (trigger: SuggestionTrigger) => SuggestionStatus,
  onOpen?: () => void,
) {
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
      });
    },
    onUpdate: (props: SuggestionProps<SuggestionItem, SuggestionItem>) => {
      store.update({
        query: props.query,
        items: props.items,
        status: getStatus(trigger),
        command: props.command,
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
          // menu opens at start-of-line with a short query, so repurposing the
          // horizontal arrows for tab nav beats caret movement here.
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
          store.close();
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
  /** Called when the @ menu opens — forces a fresh workspace file read so a
   *  file the agent just created (composer never blurred → no focus refresh)
   *  is mentionable. The async landing re-pushes results into the open menu. */
  onMentionOpen: () => void;
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
      prEnabled: () => false,
      onPickMention: noop,
      onPickSlash: noop,
      onPickPr: noop,
    };
  },

  addProseMirrorPlugins() {
    const o = this.options;
    return [
      Suggestion<MentionItem, MentionItem>({
        editor: this.editor,
        char: "@",
        pluginKey: new PluginKey("composerMention"),
        items: ({ query }) => o.getMentionItems(query),
        command: ({ editor, range, props }) =>
          o.onPickMention(editor, range, props),
        render: makeRender(o.store, "@", o.getStatus, o.onMentionOpen) as never,
      }),
      Suggestion<AvailableCommand, AvailableCommand>({
        editor: this.editor,
        char: "/",
        pluginKey: new PluginKey("composerSlash"),
        startOfLine: true,
        items: ({ query }) => o.getSlashItems(query),
        command: ({ editor, range, props }) =>
          o.onPickSlash(editor, range, props),
        render: makeRender(o.store, "/", o.getStatus) as never,
      }),
      Suggestion<PrPickerItem, PrPickerItem>({
        editor: this.editor,
        char: "#",
        pluginKey: new PluginKey("composerPr"),
        allow: () => o.prEnabled(),
        items: ({ query }) => o.getPrItems(query),
        command: ({ editor, range, props }) =>
          o.onPickPr(editor, range, props),
        render: makeRender(o.store, "#", o.getStatus) as never,
      }),
    ];
  },
});
