// ──────────────────────────────────────────────────────────
// prewarmFileSyntax — load a file's grammar before its editor mounts
// ──────────────────────────────────────────────────────────
//
// The editor's Shiki layer can only theme its FIRST painted frame when the
// grammar + theme are already in the shared highlighter (tokenizeSync). Shiki
// pre-loads the common set, but the long tail — Dockerfile, .ini, .diff, .java,
// Vue … — imports on demand, and an import that starts when the editor mounts is
// always one paint too late.
//
// So every path that reads a file for display warms its language in parallel with
// the read IPC (see workspace-file-data-cache): the grammar import and the file
// read race each other instead of running back to back, and the editor mounts
// into an already-warm highlighter. Deduplicated and failure-tolerant inside
// prewarmSyntax — an extension shiki has no grammar for is warmed once and then
// left alone.
// ──────────────────────────────────────────────────────────

import { prewarmSyntax } from "@/zeros/agent/renderers/syntax";
import { shikiLangForPath } from "./shiki-lang";

/** Fire-and-forget: warm the Shiki grammar for `path` under the active code
 *  theme. No-op for a missing path or an extension with no Shiki language. */
export function prewarmFileSyntax(path: string | undefined): void {
  const lang = shikiLangForPath(path);
  if (!lang) return;
  void prewarmSyntax(lang);
}
