// ──────────────────────────────────────────────────────────
// segments.ts — ordered composer content model
// ──────────────────────────────────────────────────────────
//
// The editor's ProseMirror doc is walked, in document order, into a flat
// list of segments: plain text runs interleaved with inline mention pills
// and inline attachment pills (exactly where the user placed them at the
// caret). This is the seam between the rich editor and the rest of the app:
//
//   • displayText / wireText — text + mention tokens, attachments omitted
//     (the agent reads the prompt string; attachments ride as content
//     blocks, same as before).
//   • the user-message bubble — renders these segments inline so a sent
//     message looks identical to what was composed (user spec 2026-06-08).
//
// Attachment segments carry only an `attachmentId`; the bytes live in the
// editor hook's side store keyed by that id, so the doc/JSON stays small.
// ──────────────────────────────────────────────────────────

export type ComposerSegment =
  | { type: "text"; text: string }
  | {
      type: "mention";
      /** Serialized token inserted into the prompt string (e.g. "`src/foo.ts`"
       *  or "@selection"). */
      token: string;
      /** Display label shown on the pill. */
      label: string;
      /** Repo-relative path (files/folders) — drives the pill icon. */
      path: string;
      kind: "file" | "folder" | "selection";
    }
  | {
      type: "attachment";
      /** Key into the editor hook's attachment side store (the bytes). */
      attachmentId: string;
      name: string;
      mimeType: string;
      kind: "image" | "text";
    };
