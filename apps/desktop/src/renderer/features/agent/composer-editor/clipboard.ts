import type { JSONContent } from "@tiptap/core";
import { Slice } from "@tiptap/pm/model";
import type { EditorView } from "@tiptap/pm/view";
import {
  safeAttachmentFilename,
  validateAttachmentFile,
  ATTACHMENT_CLIPBOARD_MIME,
} from "@zeros/protocol/attachment-policy";
import type { ComposerAttachment } from "../composer-attachments";
import { attachmentOwner, sameAttachmentOwner } from "../attachment-owner";
import { rememberAttachmentClipboardSources } from "../attachment-source-retention";
import {
  prepareAttachmentSource,
  supplyLegacyAttachmentBytes,
} from "../attachment-sources";

const MIME = ATTACHMENT_CLIPBOARD_MIME;
const HTML_ATTRIBUTE = "data-zeros-composer";
type Owner = NonNullable<ComposerAttachment["owner"]>;
interface ClipboardSlice {
  content: JSONContent[];
  openStart: number;
  openEnd: number;
}
interface ClipboardPayload {
  version: 1;
  owner: Owner;
  slice: ClipboardSlice;
  attachments: ComposerAttachment[];
  text: string;
}

export function unavailableAttachment(
  attrs: Record<string, unknown>,
): ComposerAttachment {
  return {
    id: String(attrs.attachmentId ?? ""),
    name: String(attrs.name ?? "Attachment"),
    mimeType: String(attrs.mimeType ?? "application/octet-stream"),
    kind: "file",
    size: 0,
    data: "",
    delivery: "reference",
    validation: { ok: true },
    unavailable: true,
  };
}

function referenceMetadata(
  a: ComposerAttachment,
  owner: Owner,
): ComposerAttachment {
  return {
    id: a.id,
    contextAttachmentId: a.contextAttachmentId ?? a.id,
    name: a.name,
    mimeType: a.mimeType,
    kind: a.kind,
    size: a.size,
    data: "",
    delivery: "reference",
    validation: validateAttachmentFile(a),
    diskPath: a.diskPath,
    absolutePath: a.absolutePath,
    owner: a.owner ?? owner,
    sourceRecoveryId: a.sourceRecoveryId,
    sourceKey: a.sourceKey,
    preview: a.preview,
    unavailable: a.unavailable,
  };
}

function sourcePath(a: ComposerAttachment, owner: Owner): string {
  const source = a.owner ?? owner;
  const relative =
    a.diskPath ??
    `.context/local/attachments/${a.contextAttachmentId ?? a.id}/${safeAttachmentFilename(a.name)}`;
  const absolute =
    a.absolutePath ?? `${source.cwd.replace(/\/$/, "")}/${relative}`;
  return source.runtime.startsWith("local")
    ? absolute
    : `[${source.runtime}] ${absolute}`;
}

export function clipboardPayload(
  slice: ClipboardSlice,
  getAttachment: (id: string) => ComposerAttachment | undefined,
  owner: Owner,
): ClipboardPayload {
  const attachments = new Map<string, ComposerAttachment>();
  const textOf = (node: JSONContent): string => {
    if (node.type === "attachment") {
      const a =
        getAttachment(node.attrs?.attachmentId) ??
        unavailableAttachment(node.attrs ?? {});
      if (a.delivery !== "reference" && a.validation.ok) {
        supplyLegacyAttachmentBytes(a);
        if (a.sourceFile && !a.sourceRecoveryId)
          void prepareAttachmentSource(a).catch(() => {});
      }
      attachments.set(a.id, referenceMetadata(a, owner));
      return sourcePath(a, owner);
    }
    if (node.type === "mention")
      return node.attrs?.token || node.attrs?.label || "";
    if (node.type === "hardBreak") return "\n";
    return node.text ?? node.content?.map(textOf).join("") ?? "";
  };
  const text = slice.content.map(textOf).join("\n");
  return {
    version: 1,
    owner,
    slice,
    attachments: [...attachments.values()],
    text,
  };
}

function validOwner(value: unknown): value is Owner {
  const owner = value as Owner | null;
  return (
    !!owner &&
    typeof owner.runtime === "string" &&
    typeof owner.cwd === "string" &&
    owner.cwd.length > 0
  );
}

/** Clipboard metadata is untrusted. Reconstruct only whitelisted reference
 * fields; the engine resolves ids inside the authorized destination root. */
export function prepareClipboardPaste(
  input: unknown,
  owner: Owner,
): { slice: ClipboardSlice; attachments: ComposerAttachment[] } | null {
  const payload = input as ClipboardPayload | null;
  if (
    !payload ||
    payload.version !== 1 ||
    !validOwner(payload.owner) ||
    !Array.isArray(payload.attachments) ||
    payload.attachments.length > 1000 ||
    !Array.isArray(payload.slice?.content)
  )
    return null;
  const refs = new Map<string, ComposerAttachment>();
  for (const a of payload.attachments) {
    if (
      !a ||
      typeof a.id !== "string" ||
      typeof a.name !== "string" ||
      typeof a.mimeType !== "string" ||
      !["file", "text", "image"].includes(a.kind) ||
      !Number.isSafeInteger(a.size) ||
      a.size < 0 ||
      (a.owner && !validOwner(a.owner))
    )
      return null;
    for (const field of [
      a.contextAttachmentId,
      a.diskPath,
      a.absolutePath,
      a.sourceRecoveryId,
      a.sourceKey,
    ])
      if (field !== undefined && typeof field !== "string") return null;
    if (a.preview) {
      const preview = a.preview;
      if (
        (preview.agentId !== null && typeof preview.agentId !== "string") ||
        (preview.agentName !== null && typeof preview.agentName !== "string") ||
        !Number.isSafeInteger(preview.userMessageCount) ||
        preview.userMessageCount < 0 ||
        !Number.isFinite(preview.lastMessageAt)
      )
        return null;
    }
    refs.set(a.id, referenceMetadata(a, payload.owner));
  }
  const attachments: ComposerAttachment[] = [];
  let count = 0;
  const visit = (node: JSONContent, depth = 0): JSONContent => {
    if (!node || depth > 32 || ++count > 50_000)
      throw new Error("Invalid clipboard document");
    if (node.type === "attachment") {
      const a =
        refs.get(node.attrs?.attachmentId) ??
        unavailableAttachment(node.attrs ?? {});
      if (!sameAttachmentOwner(a.owner ?? payload.owner, owner))
        return { type: "text", text: sourcePath(a, payload.owner) };
      const pasted = { ...a, id: `att-paste-${crypto.randomUUID()}`, owner };
      attachments.push(pasted);
      return {
        type: "attachment",
        attrs: {
          attachmentId: pasted.id,
          name: pasted.name,
          mimeType: pasted.mimeType,
          kind: pasted.kind,
          sourceKey: pasted.sourceKey ?? "",
        },
      };
    }
    if (node.type === "mention" && !sameAttachmentOwner(payload.owner, owner)) {
      const path = String(node.attrs?.path ?? "");
      return {
        type: "text",
        text: path
          ? `${payload.owner.runtime.startsWith("local") ? "" : `[${payload.owner.runtime}] `}${path.startsWith("/") ? path : `${payload.owner.cwd}/${path}`}`
          : String(node.attrs?.token || node.attrs?.label || "@selection"),
      };
    }
    return {
      ...node,
      ...(node.content
        ? { content: node.content.map((child) => visit(child, depth + 1)) }
        : {}),
    };
  };
  try {
    const slice = {
      ...payload.slice,
      openStart: payload.slice.openStart ?? 0,
      openEnd: payload.slice.openEnd ?? 0,
      content: payload.slice.content.map((node) => visit(node)),
    };
    if (
      !Number.isInteger(slice.openStart) ||
      !Number.isInteger(slice.openEnd) ||
      slice.openStart < 0 ||
      slice.openStart > 32 ||
      slice.openEnd < 0 ||
      slice.openEnd > 32
    )
      return null;
    return { slice, attachments };
  } catch {
    return null;
  }
}

export function copyComposerSelection(
  view: EditorView,
  event: ClipboardEvent,
  cwd: string | null,
  getAttachment: (id: string) => ComposerAttachment | undefined,
): boolean {
  if (!event.clipboardData || view.state.selection.empty || !cwd) return false;
  const { dom, slice } = view.serializeForClipboard(
    view.state.selection.content(),
  );
  const payload = clipboardPayload(
    slice.toJSON(),
    getAttachment,
    attachmentOwner(cwd),
  );
  const encoded = JSON.stringify(payload);
  dom.setAttribute(HTML_ATTRIBUTE, encoded);
  event.clipboardData.setData(MIME, encoded);
  event.clipboardData.setData("text/html", dom.outerHTML);
  event.clipboardData.setData("text/plain", payload.text);
  rememberAttachmentClipboardSources(payload);
  event.preventDefault();
  if (event.type === "cut" && view.editable)
    view.dispatch(
      view.state.tr
        .deleteSelection()
        .scrollIntoView()
        .setMeta("uiEvent", "cut"),
    );
  return true;
}

export function pasteComposerClipboard(
  view: EditorView,
  event: ClipboardEvent,
  cwd: string | null,
  attachments: Map<string, ComposerAttachment>,
): boolean {
  if (!event.clipboardData || !cwd) return false;
  let encoded = event.clipboardData.getData(MIME);
  if (!encoded) {
    const html = event.clipboardData.getData("text/html");
    if (html.length > 2_000_000 || !html.includes(HTML_ATTRIBUTE)) return false;
    encoded =
      new DOMParser()
        .parseFromString(html, "text/html")
        .querySelector(`[${HTML_ATTRIBUTE}]`)
        ?.getAttribute(HTML_ATTRIBUTE) ?? "";
  }
  if (!encoded || encoded.length > 2_000_000) return false;
  try {
    const pasted = prepareClipboardPaste(
      JSON.parse(encoded),
      attachmentOwner(cwd),
    );
    if (!pasted) return false;
    const slice = Slice.fromJSON(view.state.schema, pasted.slice);
    const transaction = view.state.tr
      .replaceSelection(slice)
      .scrollIntoView()
      .setMeta("paste", true)
      .setMeta("uiEvent", "paste");
    // Side metadata must exist before onUpdate schedules saves and staging.
    for (const a of pasted.attachments) attachments.set(a.id, a);
    view.dispatch(transaction);
    event.preventDefault();
    return true;
  } catch {
    return false;
  }
}
