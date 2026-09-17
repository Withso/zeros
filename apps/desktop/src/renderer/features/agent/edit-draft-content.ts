import type { ComposerAttachment } from "./composer-attachments";

type DraftContent = { json?: object | null; attachments: ComposerAttachment[] };

/** Compare the whole document, including ordered mentions and attachment
 * identities. Reconstructed chips get fresh editor ids; their durable record
 * identity stays the same across reopening and local/shared moves. */
export function isPristineEditDraft(
  draft: DraftContent,
  original: DraftContent,
): boolean {
  if (!draft.json || !original.json) return false;
  const canonical = (content: DraftContent): string => {
    const attachments = new Map(content.attachments.map((a) => [a.id, a]));
    function visit(value: unknown): unknown {
      if (Array.isArray(value)) return value.map(visit);
      if (!value || typeof value !== "object") return value;
      const node = value as Record<string, unknown>;
      if (node.type === "attachment") {
        const attrs = (node.attrs ?? {}) as Record<string, unknown>;
        const attachment = attachments.get(String(attrs.attachmentId));
        const graphId = attachment?.diskPath?.match(
          /^\.context(?:-graph)?\/(?:local|shared)\/attachments\/([^/]+)\//,
        )?.[1];
        return [
          "attachment",
          attachment?.contextAttachmentId ??
            graphId ??
            attachment?.diskPath ??
            attrs.attachmentId,
          attrs.name,
          attrs.mimeType,
          attrs.kind,
          attrs.sourceKey || "",
        ];
      }
      return Object.fromEntries(
        Object.keys(node)
          .sort()
          .map((key) => [key, visit(node[key])]),
      );
    }
    return JSON.stringify(visit(content.json));
  };
  return canonical(draft) === canonical(original);
}
