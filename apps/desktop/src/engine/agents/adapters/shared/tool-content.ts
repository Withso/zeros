import type { ContentBlock } from "../../types";

export type CanonicalToolContent = Array<{
  type: "content";
  content: ContentBlock;
}>;
const MAX_TEXT = 256_000;
const MAX_MEDIA = 16 * 1024 * 1024;
const MAX_BLOCKS = 128;
const obj = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
const string = (v: unknown, limit = 4096) =>
  typeof v === "string" && v.length > 0 && v.length <= limit ? v : undefined;

function encodedData(owner: unknown, data: string): boolean {
  const record = obj(owner);
  return (
    ["image", "audio", "base64"].includes(String(record.type)) ||
    /^(?:image|audio)\//.test(
      String(record.mimeType ?? record.media_type ?? ""),
    ) ||
    (data.length > 256 && /^[A-Za-z0-9+/]+={0,2}$/.test(data))
  );
}

/** Native content, not arbitrary nested metadata. Bound before persistence and
 * retain resource identities even when an embedded binary cannot be displayed. */
export function canonicalToolContent(value: unknown): CanonicalToolContent {
  const candidates =
    typeof value === "string"
      ? [{ type: "text", text: value }]
      : Array.isArray(value)
        ? value
        : [];
  const result: CanonicalToolContent = [];
  let remainingText = MAX_TEXT;
  let remainingMedia = MAX_MEDIA;
  for (const candidate of candidates.slice(0, MAX_BLOCKS)) {
    const b = obj(candidate);
    let content: ContentBlock | undefined;
    const text = typeof b.text === "string" ? b.text : obj(b.text).text;
    if (typeof text === "string" && remainingText > 0) {
      const bounded = text.slice(0, remainingText);
      remainingText -= bounded.length;
      if (bounded)
        content = {
          type: "text",
          text:
            bounded + (bounded.length < text.length ? "\n[…truncated]" : ""),
        };
    } else if (b.type === "image" || b.type === "audio") {
      const source = obj(b.source);
      const mimeType = string(b.mimeType ?? source.media_type, 128);
      const data = string(b.data ?? source.data, remainingMedia);
      const uri = string(b.uri ?? source.url);
      if (
        mimeType?.startsWith(`${b.type}/`) &&
        data &&
        /^[A-Za-z0-9+/]+={0,2}$/.test(data)
      ) {
        remainingMedia -= data.length;
        content = { type: b.type, mimeType, data };
      } else if (b.type === "image" && uri && /^https?:\/\//i.test(uri)) {
        content = {
          type: "image",
          uri,
          data: "",
          mimeType: mimeType ?? "image/png",
        };
      }
    } else if (b.type === "resource_link") {
      const uri = string(b.uri);
      if (uri)
        content = {
          type: "resource_link",
          uri,
          name: string(b.name) ?? uri,
          ...(string(b.title) ? { title: string(b.title) } : {}),
          ...(string(b.description, 16_384)
            ? { description: string(b.description, 16_384) }
            : {}),
          ...(string(b.mimeType, 128)
            ? { mimeType: string(b.mimeType, 128) }
            : {}),
          ...(typeof b.size === "number" &&
          Number.isFinite(b.size) &&
          b.size >= 0
            ? { size: b.size }
            : {}),
        };
    } else if (b.type === "resource") {
      const resource = obj(b.resource);
      const uri = string(resource.uri);
      const mimeType = string(resource.mimeType, 128);
      if (uri && typeof resource.text === "string" && remainingText > 0) {
        const text = resource.text.slice(0, remainingText);
        remainingText -= text.length;
        content = {
          type: "resource",
          resource: {
            uri,
            ...(mimeType ? { mimeType } : {}),
            text:
              text +
              (text.length < resource.text.length ? "\n[…truncated]" : ""),
          },
        };
      } else if (uri) {
        content = {
          type: "resource_link",
          uri,
          name: uri,
          ...(mimeType ? { mimeType } : {}),
        };
      }
    }
    if (content) {
      const raw = obj(b.annotations);
      const audience = Array.isArray(raw.audience)
        ? raw.audience
            .filter(
              (v): v is "user" | "assistant" =>
                v === "user" || v === "assistant",
            )
            .slice(0, 2)
        : undefined;
      const annotations = {
        ...(audience?.length ? { audience } : {}),
        ...(typeof raw.priority === "number" &&
        raw.priority >= 0 &&
        raw.priority <= 1
          ? { priority: raw.priority }
          : {}),
        ...(string(raw.lastModified, 128)
          ? { lastModified: string(raw.lastModified, 128) }
          : {}),
      };
      if (Object.keys(annotations).length) content.annotations = annotations;
      result.push({ type: "content", content });
    }
  }
  return result;
}

/** Notifications can repeat links already present in the foreground result. */
export function mergeToolContent(
  ...groups: CanonicalToolContent[]
): CanonicalToolContent {
  const seen = new Set<string>();
  return groups
    .flat()
    .filter(({ content }) => {
      const key =
        content.type === "resource_link"
          ? `resource:${content.uri}`
          : JSON.stringify(content);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, MAX_BLOCKS);
}

/** Structured MCP siblings must remain inspectable without copying binary
 * payloads, unbounded graphs or provider-private metadata into the database. */
export function boundedStructuredOutput(value: unknown): unknown {
  const seen = new Set<object>();
  let nodes = 2048;
  let characters = MAX_TEXT;
  const visit = (v: unknown, depth: number): unknown => {
    if (--nodes < 0 || characters <= 0 || depth > 10) return "[…truncated]";
    if (typeof v === "string") {
      if (/^data:[^,]+;base64,/i.test(v)) return "[binary omitted]";
      const text = v.slice(0, characters);
      characters -= text.length;
      return text + (text.length < v.length ? "[…truncated]" : "");
    }
    if (!v || typeof v !== "object") return v;
    if (seen.has(v)) return "[circular]";
    seen.add(v);
    const result = Array.isArray(v)
      ? v.slice(0, 128).map((e) => visit(e, depth + 1))
      : Object.fromEntries(
          Object.entries(v)
            .slice(0, 128)
            .flatMap(([k, e]) => {
              if (k === "_meta") {
                // Existing native Browser/Computer presentations consume these
                // exact fields. Keep them bounded; omit arbitrary server metadata.
                const metadata = obj(e);
                const allowed = [
                  "browser_use",
                  "browserUse",
                  "codex/browserUse",
                  "codex/toolSurface",
                ];
                const retained = Object.fromEntries(
                  allowed
                    .filter((key) => key in metadata)
                    .map((key) => [key, metadata[key]]),
                );
                return Object.keys(retained).length
                  ? [[k, visit(retained, depth + 1)]]
                  : [];
              }
              if (
                typeof e === "string" &&
                (/^(?:blob|base64|imageData|encrypted_content)$/i.test(k) ||
                  (k === "data" && encodedData(v, e)))
              )
                return [];
              return [[k, visit(e, depth + 1)]];
            }),
        );
    seen.delete(v);
    return result;
  };
  return visit(value, 0);
}

/** Claude's SDKMcpResourceLink envelope intentionally omits MCP's type tag. */
export function canonicalResourceLinks(value: unknown): CanonicalToolContent {
  if (!Array.isArray(value)) return [];
  let remaining = 64 * 1024;
  return canonicalToolContent(
    value.slice(0, 50).map((v) => ({ ...obj(v), type: "resource_link" })),
  ).filter((block) => {
    remaining -= JSON.stringify(block).length;
    return remaining >= 0;
  });
}
