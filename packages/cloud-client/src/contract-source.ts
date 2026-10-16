// The frozen S3 schemas live inside the contract markdown until the Zod port
// (see "Draft schema" sections of s3-client-contract.md). This module is the
// single reader of those fenced blocks; the type generator, the contract
// mock and the round-trip tests all consume it, so nothing copies a schema
// by hand. Test/tooling code only — runtime client code must not read docs.

import { readFileSync } from "node:fs";

import { load } from "js-yaml";

export type JsonObject = Record<string, unknown>;

export interface ContractSchemas {
  openApi: JsonObject;
  deviceStream: JsonObject;
  runtimeAuth: JsonObject;
}

export const CONTRACT_DOC = new URL(
  "../../../docs/cloud-workspace/contracts/s3-client-contract.md",
  import.meta.url,
);

function block(text: string, name: string, lang: "json" | "yaml"): string {
  const marker = `<!-- contract-schema: ${name} (${lang}) -->\n\`\`\`${lang}\n`;
  const start = text.indexOf(marker);
  if (start < 0)
    throw new Error(`s3-client-contract.md has no fenced ${lang} block after the ${name} marker`);
  const bodyStart = start + marker.length;
  const end = text.indexOf("\n```", bodyStart);
  if (end < 0) throw new Error(`s3-client-contract.md leaves the ${name} block unterminated`);
  return text.slice(bodyStart, end + 1);
}

export function loadContractSchemas(doc: URL = CONTRACT_DOC): ContractSchemas {
  const text = readFileSync(doc, "utf8");
  return {
    openApi: load(block(text, "s3-client-api", "yaml")) as JsonObject,
    deviceStream: JSON.parse(block(text, "s3-device-stream-events", "json")) as JsonObject,
    runtimeAuth: JSON.parse(block(text, "s3-runtime-auth-frames", "json")) as JsonObject,
  };
}

/** Rewrite OpenAPI component refs into JSON Schema $defs refs. */
function rewriteRefs(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(rewriteRefs);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as JsonObject).map(([key, entry]) => [
      key,
      key === "$ref" && typeof entry === "string"
        ? entry.replace("#/components/schemas/", "#/$defs/")
        : rewriteRefs(entry),
    ]),
  );
}

/**
 * A standalone JSON Schema that validates one OpenAPI component schema from
 * the contract document, with every sibling component available as a $def.
 */
export function openApiComponentSchema(
  openApi: JsonObject,
  name: string,
): JsonObject {
  const schemas = (openApi.components as JsonObject).schemas as JsonObject;
  if (!Object.hasOwn(schemas, name))
    throw new Error(`the contract OpenAPI has no components.schemas.${name}`);
  return {
    $defs: rewriteRefs(schemas),
    $ref: `#/$defs/${name}`,
  };
}
