import { Extension } from "@tiptap/core";
import type { Node } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { AvailableCommand } from "../../../platform/bridge/agent-events";

export const slashCommandDecorationKey = new PluginKey<DecorationSet>("composerCommandAccent");

/** Presentation only: commands remain editable text on the wire and in drafts. */
export function slashCommandDecorations(doc: Node, commands: readonly AvailableCommand[]): DecorationSet {
  const names = new Set(commands.filter(command => command.kind !== "skill").map(command => command.name));
  const decorations: Decoration[] = [];
  doc.descendants((node, position) => {
    if (!node.isText || !node.text) return;
    // Whitespace boundaries exclude URLs, repo paths and ordinary slash prose.
    // The terminator prevents coloring a command-shaped prefix of a path.
    for (const match of node.text.matchAll(/(^|\s)\/([a-zA-Z0-9][\w:-]*)(?=$|[\s.,!?;)\]}])/g)) {
      if (!names.has(match[2])) continue;
      const from = position + match.index! + match[1].length;
      decorations.push(Decoration.inline(from, from + match[2].length + 1, {
        "data-slash-command": match[2],
        class: "text-yellow-primary",
      }));
    }
  });
  return DecorationSet.create(doc, decorations);
}

export const SlashCommandDecoration = Extension.create<{ commands: () => readonly AvailableCommand[] }>({
  name: "slashCommandDecoration",
  addOptions: () => ({ commands: () => [] }),
  addProseMirrorPlugins() {
    const commands = this.options.commands;
    return [new Plugin({
      key: slashCommandDecorationKey,
      state: {
        init: (_, state) => slashCommandDecorations(state.doc, commands()),
        apply: (transaction, previous) => transaction.docChanged || transaction.getMeta(slashCommandDecorationKey)
          ? slashCommandDecorations(transaction.doc, commands()) : previous,
      },
      props: { decorations: state => slashCommandDecorationKey.getState(state) },
    })];
  },
});
