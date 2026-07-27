// ──────────────────────────────────────────────────────────
// attachment-io.ts — pure file → ComposerAttachment reader
// ──────────────────────────────────────────────────────────
//
// The TipTap composer stages dropped/pasted/picked files as INLINE
// attachment pills at the caret. Reading + validating the file is the same
// work the legacy `useComposerAttachments` array hook did; this is that
// pipeline as a pure async function returning the built ComposerAttachment[]
// (the editor then inserts a node per attachment and keeps the bytes in a
// side store keyed by id, so the ProseMirror doc stays lightweight).
// ──────────────────────────────────────────────────────────

import { validateAttachment } from "../agent-attachments";
import type { ComposerAttachment } from "../composer-attachments";

function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== "string") {
        reject(new Error("Failed to read file"));
        return;
      }
      const comma = result.indexOf(",");
      resolve(comma === -1 ? result : result.slice(comma + 1));
    };
    reader.onerror = () => reject(reader.error ?? new Error("read error"));
    reader.readAsDataURL(file);
  });
}

const TEXT_LIKE_EXTENSIONS = [
  ".md", ".markdown", ".txt", ".text",
  ".json", ".yaml", ".yml", ".toml", ".csv",
  ".ts", ".tsx", ".js", ".jsx",
  ".py", ".rb", ".go", ".rs", ".sh", ".bash", ".zsh",
  ".env",
];

function looksLikeText(file: File): boolean {
  if (file.type.startsWith("text/")) return true;
  if (file.type === "application/json") return true;
  if (file.type === "application/x-yaml" || file.type === "application/yaml")
    return true;
  const lowered = file.name.toLowerCase();
  return TEXT_LIKE_EXTENSIONS.some((ext) => lowered.endsWith(ext));
}

export interface FilesToAttachmentsOpts {
  agentName: string | null | undefined;
  agentSupportsImage: boolean | undefined;
  modelId: string | null | undefined;
}

/** Read a FileList/File[] into validated ComposerAttachments (images →
 *  base64; text-like files → decoded body). Unsupported types are skipped
 *  with a warn, mirroring the legacy hook exactly. */
export async function filesToAttachments(
  files: FileList | File[] | null | undefined,
  opts: FilesToAttachmentsOpts,
): Promise<ComposerAttachment[]> {
  if (!files) return [];
  const list = Array.from(files);
  if (list.length === 0) return [];
  const out: ComposerAttachment[] = [];
  for (const file of list) {
    const id = `att-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    if (file.type.startsWith("image/")) {
      try {
        const data = await readFileAsBase64(file);
        out.push({
          id,
          name: file.name,
          mimeType: file.type,
          kind: "image",
          data,
          size: file.size,
          validation: validateAttachment({
            kind: "image",
            size: file.size,
            agentName: opts.agentName ?? null,
            agentSupportsImage: opts.agentSupportsImage,
            modelId: opts.modelId ?? null,
          }),
        });
      } catch {
        /* skip unreadable */
      }
      continue;
    }
    if (looksLikeText(file)) {
      try {
        const text = await file.text();
        out.push({
          id,
          name: file.name,
          mimeType: file.type || "text/plain",
          kind: "text",
          data: "",
          text,
          size: file.size,
          validation: validateAttachment({
            kind: "text",
            size: file.size,
            agentName: opts.agentName ?? null,
            agentSupportsImage: opts.agentSupportsImage,
            modelId: opts.modelId ?? null,
          }),
        });
      } catch {
        /* skip unreadable */
      }
      continue;
    }
    console.warn(
      `[Zeros] dropped unsupported file type: ${file.name} (${file.type || "unknown"})`,
    );
  }
  return out;
}
