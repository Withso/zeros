// ──────────────────────────────────────────────────────────
// attachment-keys — finding keyed attachments in the composer document
// ──────────────────────────────────────────────────────────
//
// The document is the single source of truth for "is this chat's transcript
// attached" (see chat-transcript-pills.tsx). These two functions are the read
// side of that, kept pure and separate from the editor so the position math is
// testable in a node environment — the renderer has no DOM test harness, and
// this is precisely the code where a subtle bug would be invisible until it
// mangled someone's prompt.
// ──────────────────────────────────────────────────────────

import type { Node as ProseMirrorNode } from "@tiptap/pm/model";

/** One attachment node's span and identity. */
export interface AttachmentHit {
  /** Document position of the node. */
  from: number;
  /** Position just past it. */
  to: number;
  /** Key into the editor hook's side store, so the bytes can be dropped too. */
  attachmentId: string;
}

/** Every non-empty `sourceKey` in the document, in document order. */
export function collectSourceKeys(doc: ProseMirrorNode): string[] {
  const keys: string[] = [];
  doc.descendants((node) => {
    if (node.type.name !== "attachment") return;
    const key = node.attrs.sourceKey;
    if (typeof key === "string" && key) keys.push(key);
  });
  return keys;
}

/** Attachment nodes carrying `sourceKey`, ordered HIGHEST POSITION FIRST.
 *
 *  The order is the whole point. Every delete shifts the positions of
 *  everything after it, so a caller that collected positions up front and then
 *  deleted front-to-back would cut the wrong ranges from the second hit
 *  onwards — silently mangling the user's prompt. Descending order means each
 *  delete only moves positions the caller has already used. */
export function findAttachmentsBySourceKey(
  doc: ProseMirrorNode,
  sourceKey: string,
): AttachmentHit[] {
  // "" is the DEFAULT for every pasted, dropped and picked file, so an empty
  // query would match all of them and a caller with an undefined key would
  // wipe the user's attachments instead of no-opping. Not a hypothetical: the
  // key is built from a chatId, and a chatId is string-typed but not
  // guaranteed non-empty at every call site.
  if (!sourceKey) return [];
  const hits: AttachmentHit[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name !== "attachment") return;
    if (node.attrs.sourceKey !== sourceKey) return;
    let to = pos + node.nodeSize;
    // Swallow the single separator space the insert put after the node.
    // Without this, attaching and un-attaching leaves an invisible space
    // behind: the composer reports itself non-empty, so the placeholder stays
    // hidden and Send looks enabled — but handleSend early-returns on an
    // empty trimmed prompt, so Enter does nothing with no feedback. The pill
    // makes that a one-gesture round trip, and each one adds another space.
    const after = doc.nodeAt(to);
    if (after?.isText && after.text?.startsWith(" ")) to += 1;
    hits.push({
      from: pos,
      to,
      attachmentId: String(node.attrs.attachmentId ?? ""),
    });
  });
  return hits.sort((a, b) => b.from - a.from);
}
