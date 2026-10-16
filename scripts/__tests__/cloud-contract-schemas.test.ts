import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { load } from "js-yaml";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");
const contracts = join(root, "docs/cloud-workspace/contracts");

type JsonObject = Record<string, unknown>;

// Draft schemas live in the markdown contract that owns them until freeze, so
// CI path rules see documentation only. Each block follows a marker line.
const expectedBlocks = {
  "s1-capability-claims": { doc: "s1-capabilities.md", lang: "json" },
  "s2-uplink-frames": { doc: "s2-uplink.md", lang: "json" },
  "s3-client-api": { doc: "s3-client-contract.md", lang: "yaml" },
  "s3-device-stream-events": { doc: "s3-client-contract.md", lang: "json" },
} as const;
type BlockName = keyof typeof expectedBlocks;

const MARKER = /^<!-- contract-schema: ([a-z0-9-]+) \((json|yaml)\) -->$/gm;

function readDoc(name: string): string {
  return readFileSync(join(contracts, name), "utf8");
}

function contractDocs(): string[] {
  return readdirSync(contracts).filter(name => name.endsWith(".md")).sort();
}

function markers(): { name: string; lang: string; doc: string }[] {
  return contractDocs().flatMap(doc =>
    [...readDoc(doc).matchAll(MARKER)].map(([, name, lang]) => ({ name: name!, lang: lang!, doc })));
}

function block(name: BlockName): string {
  const { doc, lang } = expectedBlocks[name];
  const marker = `<!-- contract-schema: ${name} (${lang}) -->\n\`\`\`${lang}\n`;
  const text = readDoc(doc);
  const start = text.indexOf(marker);
  if (start < 0) throw new Error(`${doc} has no fenced ${lang} block after the ${name} marker`);
  const bodyStart = start + marker.length;
  const end = text.indexOf("\n```", bodyStart);
  if (end < 0) throw new Error(`${doc} leaves the ${name} block unterminated`);
  return text.slice(bodyStart, end + 1);
}

function json(name: BlockName): JsonObject {
  return JSON.parse(block(name)) as JsonObject;
}

function proseWithoutBlocks(doc: string): string {
  return readDoc(doc).replace(/^<!-- contract-schema: [^\n]*\n```[a-z]*\n[\s\S]*?\n```$/gm, "");
}

function ajv() {
  // Frame schemas compose a shared envelope through allOf, which ajv's
  // strictRequired/strictTypes checks cannot see across; every other strict
  // check (unknown keywords, formats, tuples) stays on.
  const instance = new Ajv2020({ strict: true, strictTypes: false, strictRequired: false, allErrors: true });
  addFormats(instance);
  return instance;
}

function frameTypes(schema: JsonObject): string[] {
  const defs = schema.$defs as Record<string, JsonObject>;
  return (schema.oneOf as { $ref: string }[]).map(({ $ref }) => {
    const def = defs[$ref.replace("#/$defs/", "")]!;
    return ((def.properties as JsonObject).t as { const: string }).const;
  });
}

function rewriteRefs(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(rewriteRefs);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
    key,
    key === "$ref" && typeof entry === "string"
      ? entry.replace("#/components/schemas/", "#/$defs/")
      : rewriteRefs(entry),
  ]));
}

function collectRefs(value: unknown, refs: string[] = []): string[] {
  if (Array.isArray(value)) value.forEach(entry => collectRefs(entry, refs));
  else if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      if (key === "$ref" && typeof entry === "string") refs.push(entry);
      else collectRefs(entry, refs);
    }
  }
  return refs;
}

describe("cloud workspace contract sketches", () => {
  it("embeds each expected schema block exactly once, in its owning contract", () => {
    const found = markers();
    expect(found.map(marker => marker.name).sort()).toEqual(Object.keys(expectedBlocks).sort());
    for (const [name, expected] of Object.entries(expectedBlocks)) {
      const matches = found.filter(marker => marker.name === name);
      expect(matches, name).toHaveLength(1);
      expect(matches[0], name).toEqual({ name, ...expected });
    }
    expect(existsSync(join(contracts, "schemas"))).toBe(false);
  });

  it.each([
    "s1-capability-claims",
    "s2-uplink-frames",
    "s3-device-stream-events",
  ] as const)("%s compiles and accepts its own examples", name => {
    const schema = json(name);
    const validate = ajv().compile(schema);
    const examples = schema.examples as unknown[];
    expect(examples.length).toBeGreaterThan(0);
    for (const example of examples) {
      expect(validate(example), JSON.stringify(validate.errors)).toBe(true);
    }
  });

  it("rejects capability headers other than pinned EdDSA", () => {
    const schema = json("s1-capability-claims");
    const validate = ajv().compile(schema);
    const [example] = schema.examples as JsonObject[];
    for (const alg of ["none", "HS256", "RS256"]) {
      const forged = { ...example, header: { ...(example!.header as JsonObject), alg } };
      expect(validate(forged)).toBe(false);
    }
    const withKey = { ...example, header: { ...(example!.header as JsonObject), jwk: {} } };
    expect(validate(withKey)).toBe(false);
  });

  it("requires proof-of-possession binding on client capabilities only", () => {
    const schema = json("s1-capability-claims");
    const validate = ajv().compile(schema);
    const [client, engine] = schema.examples as { header: JsonObject; claims: JsonObject }[];
    const { cnf: _cnf, ...unbound } = client!.claims;
    expect(validate({ ...client, claims: unbound })).toBe(false);
    expect(validate({ ...engine, claims: { ...engine!.claims, cnf: client!.claims.cnf } })).toBe(false);
    expect(validate({ ...client, claims: { ...client!.claims, aud: "zeros:api" } })).toBe(false);
  });

  it("rejects unknown uplink frame types and sequenced unreliable frames", () => {
    const validate = ajv().compile(json("s2-uplink-frames"));
    expect(validate({ t: "sys.unknown", d: {} })).toBe(false);
    expect(validate({ t: "sys.ping", s: 1, d: { ts: 1 } })).toBe(false);
    expect(validate({ t: "cred.revision", d: { kind: "agent-controls", revision: 1 } })).toBe(false);
  });

  it.each([
    ["s2-uplink.md", "s2-uplink-frames"],
    ["s3-client-contract.md", "s3-device-stream-events"],
  ] as const)("%s documents every frame type in its schema outside the schema block", (doc, name) => {
    const prose = proseWithoutBlocks(doc);
    expect(prose).not.toContain("contract-schema:");
    for (const type of frameTypes(json(name))) {
      expect(prose, type).toContain(`\`${type}\``);
    }
  });

  it("parses the OpenAPI sketch, resolves every reference and compiles its schemas", () => {
    const api = load(block("s3-client-api")) as JsonObject;
    expect(api.openapi).toBe("3.1.0");
    const components = api.components as Record<string, Record<string, unknown>>;
    for (const ref of collectRefs(api)) {
      const [, section, name] = /^#\/components\/([A-Za-z]+)\/([A-Za-z0-9_]+)$/.exec(ref) ?? [];
      expect(section && name && components[section]?.[name], ref).toBeTruthy();
    }
    const instance = ajv();
    instance.addSchema({ $id: "openapi-components", $defs: rewriteRefs(components.schemas) });
    for (const name of Object.keys(components.schemas!)) {
      expect(instance.getSchema(`openapi-components#/$defs/${name}`), name).toBeTruthy();
    }
    const paths = api.paths as Record<string, Record<string, { parameters?: { $ref?: string; name?: string; in?: string }[] }>>;
    for (const [path, operations] of Object.entries(paths)) {
      const templated = [...path.matchAll(/\{([A-Za-z]+)\}/g)].map(match => match[1]);
      for (const operation of Object.values(operations)) {
        const declared = (operation.parameters ?? []).map(parameter => {
          const resolved = parameter.$ref
            ? components.parameters![parameter.$ref.split("/").pop()!] as { name: string; in: string }
            : parameter;
          return resolved.in === "path" ? resolved.name : null;
        }).filter(Boolean);
        expect(declared.sort(), path).toEqual([...templated].sort());
      }
    }
  });

  it("links only to files that exist", () => {
    const docs = contractDocs();
    expect(docs).toEqual(["README.md", "s1-capabilities.md", "s2-uplink.md", "s3-client-contract.md"]);
    for (const doc of docs) {
      const prose = proseWithoutBlocks(doc);
      for (const [, target] of prose.matchAll(/\]\(([^)#\s]+)(?:#[^)]*)?\)/g)) {
        if (/^[a-z]+:/.test(target!)) continue;
        expect(existsSync(resolve(dirname(join(contracts, doc)), target!)), `${doc} -> ${target}`).toBe(true);
      }
      for (const [, file, anchor] of prose.matchAll(/\]\(([a-z0-9-]*\.md)?#(draft-schema[a-z0-9-]*)\)/g)) {
        const headings = [...readDoc(file ?? doc).matchAll(/^#{2,4} (.+)$/gm)].map(([, heading]) =>
          heading!.toLowerCase().replace(/[^a-z0-9 -]/g, "").replace(/ /g, "-"));
        expect(headings, `${doc} -> ${file ?? ""}#${anchor}`).toContain(anchor);
      }
    }
  });
});
