import { parseEnv } from "node:util";
import { StringDecoder } from "node:string_decoder";
import { CloudEnvironmentMaterialSchema, type CloudEnvironmentMaterial } from "@zeros/protocol/cloud-v2-relay";

const identifiers = new Set(["id", "type", "kind", "role", "status", "state", "source", "sessionUpdate", "stopReason", "agentId", "providerId",
  "agent", "provider", "model", "fromModel", "toModel", "previousModel", "effort", "modeId", "currentModeId", "optionId", "optionIds", "requestId", "sessionId", "chatId", "msgId", "toolCallId", "nativeToolCallId",
  "parentToolId", "turnId", "userMessageId", "noticeId", "folder", "cwd", "workspaceId", "versionId", "revision", "deliveryEpoch", "beforeEpoch"]);
const protocolFields = new Set(["code", "severity", "failureKind", "phase", "costKind", "approvalKind", "availability", "scope", "axis", "permissionMode", "outcome", "mimeType", "audience",
  "inputType", "presentation", "autoResolution", "queuedDelivery", "queuedPresentation", "marker", "textMode", "delivery", "event"]);
const rawFields = new Set(["rawInput", "rawOutput"]);

function redactionVariants(values: readonly (string | undefined)[]): string[] {
  const variants = [...new Set(values.filter((value): value is string => !!value).flatMap(value => {
    const json = JSON.stringify(value).slice(1, -1);
    let uri = value;
    try { uri = encodeURIComponent(value); } catch { /* JSON also permits unpaired UTF-16 surrogates. */ }
    return [value, json, JSON.stringify(json).slice(1, -1), uri, Buffer.from(value).toString("base64"), Buffer.from(value).toString("base64url")];
  }))];
  if (variants.length) variants.push("[redacted]");
  return variants.sort((a, b) => b.length - a.length);
}
const redactionPattern = (variants: readonly string[]) => variants.length
  ? new RegExp(variants.map(value => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "g") : undefined;

/** Values are child inputs, never process-global state. The same immutable
 * selection scrubs diagnostics and mirrored prose, including escaped echoes. */
export class ApplicationEnvironment {
  readonly variables: Readonly<Record<string, string>>;
  private readonly pattern?: RegExp;
  private readonly carry: number;
  private readonly variants: readonly string[];

  constructor(material: CloudEnvironmentMaterial = { variables: {}, files: [] }) {
    if (!CloudEnvironmentMaterialSchema.safeParse(material).success) throw new Error("Invalid application environment.");
    this.variables = Object.freeze({ ...material.variables });
    const values = [...Object.values(material.variables), ...material.files.flatMap(file => [file.content, ...Object.values(parseEnv(file.content))])];
    const variants = this.variants = redactionVariants(values);
    this.pattern = redactionPattern(variants);
    this.carry = variants.reduce((longest, value) => Math.max(longest, value.length - 1), 0);
  }

  text(value: string): string { return this.pattern ? value.replace(this.pattern, "[redacted]") : value; }

  value<T>(value: T): T { return this.sanitize(value, false); }

  private sanitize<T>(value: T, raw: boolean): T {
    if (!this.pattern) return value;
    const visit = (input: unknown, key = "", depth = 0, raw = false): unknown => {
      raw ||= rawFields.has(key);
      if (!raw && (identifiers.has(key) || protocolFields.has(key) || /(?:Id|Ids)$/.test(key)) &&
        (typeof input !== "object" || Array.isArray(input) && input.every(item => typeof item === "string"))) return input;
      if (typeof input === "string") {
        if (key === "data" || key === "payload") {
          try { const parsed = JSON.parse(input); if (parsed && typeof parsed === "object") return JSON.stringify(visit(parsed, "", depth + 1, raw)); } catch { /* Plain text. */ }
        }
        return this.text(input);
      }
      if (!input || typeof input !== "object") return input;
      if (depth > 64) return "[redacted]";
      if (Array.isArray(input)) return input.map(item => visit(item, "", depth + 1, raw));
      const object = input as Record<string, unknown>, context = object.sessionUpdate ?? object.kind ?? key;
      return Object.fromEntries(Object.entries(input).map(([name, item]) => {
        const fact = (name === "reason" && ["model_fallback", "modelFallback", "provider_binding_detached"].includes(String(context))) ||
          (["from", "to"].includes(name) && context === "mode_switch");
        return [raw ? this.text(name) : name, !raw && fact && typeof item === "string" ? item : visit(item, name, depth + 1, raw)];
      }));
    };
    return visit(value, "", 0, raw) as T;
  }

  diagnostic(value: string): string {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === "object") return JSON.stringify(this.sanitize(parsed, true));
    } catch { /* Ordinary diagnostic text. */ }
    return this.text(value);
  }

  stream(write: (text: string) => void, privateText: readonly string[] = []): { push(chunk: Buffer): void; end(truncated?: boolean): void } {
    const decoder = new StringDecoder("utf8");
    const variants = privateText.length ? [...new Set([...this.variants, ...redactionVariants(privateText)])].sort((a, b) => b.length - a.length) : this.variants;
    const pattern = privateText.length ? redactionPattern(variants) : this.pattern;
    const carry = privateText.length ? variants.reduce((longest, value) => Math.max(longest, value.length - 1), 0) : this.carry;
    let pending = "";
    const drain = (final: boolean) => {
      let boundary = final ? pending.length : Math.max(0, pending.length - carry);
      if (!boundary) return;
      let cursor = 0, output = "";
      if (pattern) {
        pattern.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = pattern.exec(pending)) && match.index < boundary) {
          output += pending.slice(cursor, match.index) + "[redacted]";
          cursor = match.index + match[0].length;
          boundary = Math.max(boundary, cursor);
        }
      }
      output += pending.slice(cursor, boundary);
      pending = pending.slice(boundary); write(output);
    };
    return { push: chunk => { pending += decoder.write(chunk); drain(false); }, end: truncated => {
      pending += decoder.end();
      // A byte cap can cut a secret before its match completes. Discard that
      // ambiguous suffix instead of publishing it as ordinary final output.
      drain(!truncated); pending = "";
    } };
  }
}
