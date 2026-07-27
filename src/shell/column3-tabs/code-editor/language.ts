// ──────────────────────────────────────────────────────────
// CodeMirror language resolver (lazy, via @codemirror/language-data)
// ──────────────────────────────────────────────────────────
//
// Maps a file path to a CodeMirror language extension using the official
// language-data registry, which lazy-loads only the grammar that's needed.
// Coverage is ~150 languages: Lezer grammars for the common set (full
// folding + smart indent) and legacy stream modes for the long tail incl.
// Swift / Kotlin / Dart (highlight + bracket matching only — no Lezer tree, so
// no tree-based folding/indent). Returns null for an unknown extension; the
// editor still works, just without syntax highlighting.
//
// NOTE: language provides STRUCTURE (the syntax tree → folding/indent/bracket
// matching). In Phase 2b the COLOR layer is swapped to Shiki for exact parity
// with the diff view, but this language extension stays for the structure — see
// the hybrid plan in project_files_tab_editor memory.
// ──────────────────────────────────────────────────────────

import { LanguageDescription } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import type { Extension } from "@codemirror/state";

/** Resolve a CodeMirror language extension for `filePath` (lazy-loaded).
 *  Returns null when the path is missing or its extension is unrecognized. */
export async function resolveLanguage(
  filePath: string | undefined,
): Promise<Extension | null> {
  if (!filePath) return null;
  // matchFilename keys on the full filename (it checks both the filename pattern
  // and the extension list), so pass the basename, not the full path.
  const name = filePath.split(/[\\/]/).pop() ?? filePath;
  const desc = LanguageDescription.matchFilename(languages, name);
  if (!desc) return null;
  try {
    return await desc.load();
  } catch {
    return null;
  }
}
