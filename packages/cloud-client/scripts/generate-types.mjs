#!/usr/bin/env node
// ──────────────────────────────────────────────────────────
// generate-types — emit TypeScript types from the frozen S3 contract schemas
// embedded in docs/cloud-workspace/contracts/s3-client-contract.md.
//
// Supported schema constructs are exactly the ones the contract uses:
// const/enum, $ref, type (incl. nullable unions), object with
// properties/required/additionalProperties, array items, allOf/oneOf/anyOf.
// Validation keywords (pattern, min/max, format, if/then) are runtime
// concerns; the round-trip tests validate values against the markdown
// schemas with ajv, so dropping them from types loses nothing.
//
// Usage: node scripts/generate-types.mjs [--check]
// ──────────────────────────────────────────────────────────

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { load } from "js-yaml";

const CONTRACT_DOC = new URL(
  "../../../docs/cloud-workspace/contracts/s3-client-contract.md",
  import.meta.url,
);

function block(text, name, lang) {
  const marker = `<!-- contract-schema: ${name} (${lang}) -->\n\`\`\`${lang}\n`;
  const start = text.indexOf(marker);
  if (start < 0) throw new Error(`missing the ${name} contract block`);
  const bodyStart = start + marker.length;
  const end = text.indexOf("\n```", bodyStart);
  if (end < 0) throw new Error(`the ${name} block is unterminated`);
  return text.slice(bodyStart, end + 1);
}

export function loadContractSchemas(doc = CONTRACT_DOC) {
  const text = readFileSync(doc, "utf8");
  return {
    openApi: load(block(text, "s3-client-api", "yaml")),
    deviceStream: JSON.parse(block(text, "s3-device-stream-events", "json")),
    runtimeAuth: JSON.parse(block(text, "s3-runtime-auth-frames", "json")),
  };
}

/** "server.catalog.changed" → "ServerCatalogChanged"; "isoTime" → "IsoTime". */
function pascal(name) {
  return name
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join("");
}

// `Error` would shadow the global for every importer of the REST types.
const REST_RENAMES = { Error: "ContractError" };

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const key = (name) => (IDENTIFIER.test(name) ? name : JSON.stringify(name));

/** Property lines of an object schema, each padded to propIndent spaces. */
function propertyLines(schema, propIndent) {
  const properties = schema.properties ?? {};
  const required = new Set(schema.required ?? []);
  const names = [
    ...Object.keys(properties),
    ...[...required].filter((name) => !Object.hasOwn(properties, name)),
  ];
  if (names.length === 0) return null;
  const pad = " ".repeat(propIndent);
  return names
    .map((name) => {
      const prop = properties[name];
      const optional = required.has(name) ? "" : "?";
      const type = prop ? tsType(prop, propIndent + 2) : "unknown";
      return `${pad}${key(name)}${optional}: ${type};`;
    })
    .join("\n");
}

/** Object literal whose properties sit at propIndent, closing one level up. */
function objectType(schema, propIndent) {
  const lines = propertyLines(schema, propIndent);
  const additional = schema.additionalProperties;
  if (!lines) {
    if (additional && typeof additional === "object")
      return `Record<string, ${tsType(additional, propIndent)}>`;
    return "Record<string, unknown>";
  }
  let body = `{\n${lines}\n${" ".repeat(Math.max(propIndent - 2, 0))}}`;
  if (additional && typeof additional === "object")
    body += ` & Record<string, ${tsType(additional, propIndent)}>`;
  return body;
}

function tsType(schema, indent = 2) {
  if (schema === true) return "unknown";
  if (schema === false) return "never";
  if (schema.const !== undefined) return JSON.stringify(schema.const);
  if (schema.enum) return schema.enum.map((value) => JSON.stringify(value)).join(" | ");
  if (schema.$ref) return refName(schema.$ref);
  if (schema.allOf || schema.oneOf || schema.anyOf) {
    const joiner = schema.allOf ? " & " : " | ";
    const parts = (schema.allOf ?? schema.oneOf ?? schema.anyOf).map((part) =>
      tsType(part, indent),
    );
    // Own properties compose with allOf bases. The envelope bases (frame,
    // resumable) carry the required list for t/d/c, so own envelope members
    // are required even though the def does not repeat the base's required.
    if (schema.allOf && propertyLines(schema, indent)) {
      const baseRequired = ["t", "d", "c"].filter((name) =>
        Object.hasOwn(schema.properties ?? {}, name),
      );
      const own = objectType(
        {
          properties: schema.properties,
          required: [...new Set([...(schema.required ?? []), ...baseRequired])],
        },
        indent,
      );
      parts.push(own);
    }
    return parts.join(joiner);
  }
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  const mapped = types.map((type) => {
    switch (type) {
      case "string":
        return "string";
      case "integer":
      case "number":
        return "number";
      case "boolean":
        return "boolean";
      case "null":
        return "null";
      case "array": {
        const item = tsType(schema.items ?? {}, indent);
        return `${item.includes(" | ") ? `(${item})` : item}[]`;
      }
      case "object":
        return objectType(schema, indent);
      default:
        throw new Error(`unsupported schema type ${JSON.stringify(schema.type)}`);
    }
  });
  return mapped.join(" | ");
}

let currentPrefix = "";
function refName(ref) {
  const name = ref.replace(/^#\/\$defs\//, "").replace(/^#\/components\/schemas\//, "");
  const renamed = currentPrefix === "rest" ? (REST_RENAMES[name] ?? name) : name;
  return currentPrefix === "rest" ? renamed : pascal(renamed);
}

function header(source) {
  return [
    `// GENERATED from docs/cloud-workspace/contracts/s3-client-contract.md (${source}).`,
    "// Do not edit by hand; run `pnpm --dir packages/cloud-client generate`.",
    "",
  ].join("\n");
}

function emitDefs(defs, { skip = new Set() } = {}) {
  const out = [];
  for (const [name, schema] of Object.entries(defs)) {
    if (skip.has(name)) continue;
    const typeName = currentPrefix === "rest" ? (REST_RENAMES[name] ?? name) : pascal(name);
    const description = typeof schema.description === "string"
      ? `/** ${schema.description.replaceAll(/\s+/g, " ").trim()} */\n`
      : "";
    out.push(`${description}export type ${typeName} = ${tsType(schema)};\n`);
  }
  return out.join("\n");
}

export function generateRestTypes(openApi) {
  currentPrefix = "rest";
  const schemas = openApi.components.schemas;
  const operations = [];
  for (const [path, verbs] of Object.entries(openApi.paths)) {
    for (const [method, operation] of Object.entries(verbs)) {
      if (!operation.operationId) continue;
      operations.push({ id: operation.operationId, method: method.toUpperCase(), path });
    }
  }
  const names = Object.keys(schemas);
  const body = emitDefs(schemas);
  const ops = operations
    .map(
      (op) =>
        `  { id: ${JSON.stringify(op.id)}, method: ${JSON.stringify(op.method)}, path: ${JSON.stringify(op.path)} },`,
    )
    .join("\n");
  return `${header("s3-client-api")}
${body}
export const REST_OPERATIONS = [
${ops}
] as const;

export type RestOperation = (typeof REST_OPERATIONS)[number];
export type RestOperationId = RestOperation["id"];
export type RestSchemaName =\n${names.map((name) => `  | ${JSON.stringify(name)}`).join("\n")};
`;
}

function generateFrameTypes(schema, source, names) {
  currentPrefix = names.prefix;
  const defs = schema.$defs;
  const frameKeys = Object.keys(defs).filter((key) => /^(client|server)\./.test(key));
  const baseKeys = Object.keys(defs).filter((key) => !frameKeys.includes(key));
  const emitOrder = [
    ...baseKeys,
    ...frameKeys.filter((key) => key.startsWith("client.")),
    ...frameKeys.filter((key) => key.startsWith("server.")),
  ];
  const ordered = Object.fromEntries(emitOrder.map((key) => [key, defs[key]]));
  const body = emitDefs(ordered);
  const client = frameKeys.filter((key) => key.startsWith("client.")).map(pascal);
  const server = frameKeys.filter((key) => key.startsWith("server.")).map(pascal);
  return `${header(source)}
${body}
export type ${names.client} =\n${client.map((name) => `  | ${name}`).join("\n")};

export type ${names.server} =\n${server.map((name) => `  | ${name}`).join("\n")};

export type ${names.frame} = ${names.client} | ${names.server};
export type ${names.frame}Type = ${names.frame}["t"];
export type ${names.client}Type = ${names.client}["t"];
export type ${names.server}Type = ${names.server}["t"];
`;
}

export function generateDeviceStreamTypes(schema) {
  return generateFrameTypes(schema, "s3-device-stream-events", {
    prefix: "device-stream",
    client: "DeviceStreamClientFrame",
    server: "DeviceStreamServerEvent",
    frame: "DeviceStreamFrame",
  });
}

export function generateRuntimeAuthTypes(schema) {
  return generateFrameTypes(schema, "s3-runtime-auth-frames", {
    prefix: "runtime-auth",
    client: "RuntimeAuthClientFrame",
    server: "RuntimeAuthServerFrame",
    frame: "RuntimeAuthFrame",
  });
}

const GENERATED = {
  "rest.ts": (schemas) => generateRestTypes(schemas.openApi),
  "device-stream.ts": (schemas) => generateDeviceStreamTypes(schemas.deviceStream),
  "runtime-auth.ts": (schemas) => generateRuntimeAuthTypes(schemas.runtimeAuth),
};

export function main(argv = []) {
  const check = argv.includes("--check");
  const schemas = loadContractSchemas();
  mkdirSync(new URL("../src/generated/", import.meta.url), { recursive: true });
  let stale = 0;
  for (const [file, generate] of Object.entries(GENERATED)) {
    const target = new URL(`../src/generated/${file}`, import.meta.url);
    const content = generate(schemas);
    if (check) {
      const onDisk = readFileSync(target, "utf8");
      if (onDisk !== content) {
        console.error(`${file} is stale; run pnpm --dir packages/cloud-client generate`);
        stale += 1;
      }
    } else {
      writeFileSync(target, content);
      console.log(`wrote src/generated/${file}`);
    }
  }
  if (stale > 0) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main(process.argv.slice(2));
