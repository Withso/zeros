import type { Editor } from "@tiptap/core";
import { EditorState } from "@tiptap/pm/state";

/** A new draft retires plugin history together with its attachment side store. */
export function resetComposerHistory(editor: Editor): void {
  const { schema, doc, selection, storedMarks, plugins } = editor.state;
  editor.view.updateState(EditorState.create({ schema, doc, selection, storedMarks, plugins }));
}
