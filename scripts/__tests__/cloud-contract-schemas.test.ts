import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { load } from "js-yaml";
import { describe, expect, it } from "vitest";
import { CloudRuntimeBindingSchema } from "../../apps/control-plane/src/cloud-workspaces/runtime-connect-contract.js";
import { DeviceStreamOrganizationFeaturesSchema } from "../../apps/control-plane/src/realtime/device-stream-protocol.js";
import { UplinkAuthHealthRequestSchema, UplinkAuthHealthSchema, UplinkAuthHealthLostSchema } from "../../apps/control-plane/src/realtime/uplink-protocol.js";

const root = resolve(import.meta.dirname, "../..");
const contracts = join(root, "docs/cloud-workspace/contracts");
const cloudReadme = join(root, "docs/cloud-workspace/README.md");

type JsonObject = Record<string, unknown>;

// Draft schemas live in the markdown contract that owns them until freeze, so
// CI path rules see documentation only. Each block follows a marker line.
const expectedBlocks = {
  "s1-capability-claims": { doc: "s1-capabilities.md", lang: "json" },
  "s2-uplink-frames": { doc: "s2-uplink.md", lang: "json" },
  "s3-client-api": { doc: "s3-client-contract.md", lang: "yaml" },
  "s3-device-stream-events": { doc: "s3-client-contract.md", lang: "json" },
  "s3-runtime-auth-frames": { doc: "s3-client-contract.md", lang: "json" },
} as const;
type BlockName = keyof typeof expectedBlocks;

const MARKER = /^<!-- contract-schema: ([a-z0-9-]+) \((json|yaml)\) -->$/gm;
const FENCE = /^```[^\n]*\n[\s\S]*?^```$/gm;

function readDoc(name: string): string {
  return readFileSync(join(contracts, name), "utf8");
}

function contractDocs(): string[] {
  return readdirSync(contracts).filter(name => name.endsWith(".md")).sort();
}

function stripFences(text: string): string {
  return text.replace(FENCE, "");
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

function ajv() {
  // Frame schemas compose a shared envelope through allOf, which ajv's
  // strictRequired/strictTypes checks cannot see across; every other strict
  // check (unknown keywords, formats, tuples) stays on.
  const instance = new Ajv2020({ strict: true, strictTypes: false, strictRequired: false, allErrors: true });
  addFormats(instance);
  return instance;
}

function defsByType(schema: JsonObject): Map<string, JsonObject> {
  const defs = schema.$defs as Record<string, JsonObject>;
  const map = new Map<string, JsonObject>();
  for (const def of Object.values(defs)) {
    const t = (def.properties as JsonObject | undefined)?.t as { const?: string } | undefined;
    if (t?.const) map.set(t.const, def);
  }
  return map;
}

function payloadFields(prose: string, type: string): string[] | null {
    const inline = new RegExp("`" + type.replaceAll(".", "\\.") + " \\{([^`]*)\\}`");
  for (const line of prose.split("\n")) {
    if (!line.includes(`\`${type}\``) && !inline.test(line)) continue;
    const span = /`\{([^`]*)\}`/.exec(line) ?? inline.exec(line);
    if (!span) continue;
    const body = span[1]!;
    // Nested payloads (maps, arrays of objects) are described in prose, not
    // rechecked here.
    if (body.includes("{") || body.includes("[")) return null;
    const fields: string[] = [];
    for (const part of body.replace(/"[^"]*"/g, "").split(",")) {
      const name = part.split(":", 1)[0]!.trim().replace(/\?$/, "");
      if (/^[a-zA-Z][a-zA-Z0-9]*$/.test(name)) fields.push(name);
    }
    return fields;
  }
  return null;
}

function slug(heading: string): string {
  return heading.trim().toLowerCase()
    .replace(/`([^`]*)`/g, "$1")
    .replace(/[^\p{L}\p{N} _-]/gu, "")
    .replace(/\s+/g, "-");
}

function headingSlugs(absFile: string): string[] {
  const prose = stripFences(readFileSync(absFile, "utf8"));
  return [...prose.matchAll(/^#{1,6} +(.+?) *$/gm)].map(([, heading]) => slug(heading!));
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

function collectInlineSchemas(value: unknown, out: unknown[] = []): unknown[] {
  if (Array.isArray(value)) value.forEach(entry => collectInlineSchemas(entry, out));
  else if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      if (key === "schema" && entry && typeof entry === "object") out.push(entry);
      else collectInlineSchemas(entry, out);
    }
  }
  return out;
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
    "s3-runtime-auth-frames",
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

  it("requires the full epoch key set per token kind", () => {
    const schema = json("s1-capability-claims");
    const validate = ajv().compile(schema);
    const [client, engine] = schema.examples as { header: JsonObject; claims: JsonObject }[];
    for (const key of ["wa", "wr", "me", "ac", "dk"]) {
      const ep = { ...(client!.claims.ep as JsonObject) };
      delete ep[key];
      expect(validate({ ...client, claims: { ...client!.claims, ep } }), `client missing ${key}`).toBe(false);
    }
    expect(
      validate({ ...engine, claims: { ...engine!.claims, ep: { wa: 12, wr: 3 } } }),
      "engine token carries a client epoch",
    ).toBe(false);
    const engineMissing = { ...engine!, claims: { ...engine!.claims } };
    delete (engineMissing.claims as JsonObject).ep;
    expect(validate(engineMissing), "engine missing ep").toBe(false);
  });

  it("ties scopes and audiences to the token kind", () => {
    const schema = json("s1-capability-claims");
    const validate = ajv().compile(schema);
    const [client, engine] = schema.examples as { header: JsonObject; claims: JsonObject }[];
    expect(validate({
      ...client,
      claims: { ...client!.claims, scp: ["ws:read", "engine:checkpoint"] },
    }), "client token with an engine scope").toBe(false);
    expect(validate({
      ...engine,
      claims: { ...engine!.claims, scp: ["ws:read"] },
    }), "engine token with a client scope").toBe(false);
    expect(validate({
      ...engine,
      claims: { ...engine!.claims, aud: "zeros:realtime" },
    }), "engine token for the client-facing realtime audience").toBe(false);
    expect(validate({
      ...client,
      claims: { ...client!.claims, aud: "zeros:api" },
    }), "client token for the engine audience").toBe(false);
  });

  it("rejects unknown uplink frame types and sequenced unreliable frames", () => {
    const validate = ajv().compile(json("s2-uplink-frames"));
    expect(validate({ t: "sys.unknown", d: {} })).toBe(false);
    expect(validate({ t: "sys.ping", s: 1, d: { ts: 1 } })).toBe(false);
    expect(validate({ t: "cred.revision", d: { kind: "agent-controls", revision: 1 } })).toBe(false);
  });

  it("S2 detached health mirrors the bounded unsequenced contract while keeping the previous welcome valid", () => {
    const validate = ajv().compile(json("s2-uplink-frames"));
    const identity = { connectionId: "11111111-1111-4111-8111-111111111111", syncId: "22222222-2222-4222-8222-222222222222" };
    const request = { ...identity, challengeId: "33333333-3333-4333-8333-333333333333", authCursor: "cursor-1" };
    for (const [t, schema, d] of [["auth.health_request", UplinkAuthHealthRequestSchema, request],
      ["auth.health", UplinkAuthHealthSchema, { ...request, healthy: true }], ["auth.health_lost", UplinkAuthHealthLostSchema, identity]] as const) {
      expect(validate({ t, d }), JSON.stringify(validate.errors)).toBe(true);
      expect(schema.safeParse(d).success).toBe(true);
      expect(validate({ t, s: 1, d })).toBe(false);
      expect(validate({ t, d: { ...d, syncId: "wrong" } })).toBe(false);
      expect(schema.safeParse({ ...d, syncId: "wrong" }).success).toBe(false);
    }
    const welcome = { protocol: 1, features: [], resumeToken: "a".repeat(32), resumed: false, pingIntervalMs: 20_000, leaseExpiresAtMs: 1_000 };
    expect(validate({ t: "sys.welcome", d: welcome })).toBe(true);
    expect(validate({ t: "sys.welcome", d: { ...welcome, connectionId: identity.connectionId } })).toBe(true);
  });

  it.each([
    ["s2-uplink.md", "s2-uplink-frames"],
    ["s3-client-contract.md", "s3-device-stream-events"],
    ["s3-client-contract.md", "s3-runtime-auth-frames"],
  ] as const)("%s documents every frame type in its schema outside the schema block", (doc, name) => {
    const prose = stripFences(readDoc(doc)).replace(MARKER, "");
    expect(prose).not.toContain("contract-schema:");
    for (const type of defsByType(json(name)).keys()) {
      expect(prose, type).toContain(`\`${type}\``);
    }
  });

  it.each([
    ["s2-uplink.md", "s2-uplink-frames", 10],
    ["s3-client-contract.md", "s3-device-stream-events", 10],
    ["s3-client-contract.md", "s3-runtime-auth-frames", 1],
  ] as const)("%s: %s prose field names exist in the schema", (doc, name, minimum) => {
    const defs = defsByType(json(name));
    const prose = stripFences(readDoc(doc));
    let checked = 0;
    for (const [type, def] of defs) {
      const fields = payloadFields(prose, type);
      if (!fields) continue;
      checked += 1;
      const payload = (def.properties as JsonObject).d as JsonObject;
      const allowed = new Set([
        "t", "s", "a", "d",
        ...Object.keys((payload.properties as JsonObject | undefined) ?? {}),
      ]);
      for (const field of fields) {
        expect(allowed.has(field), `${type}: ${field}`).toBe(true);
      }
    }
    expect(checked, "fewer flat payloads checked than expected").toBeGreaterThanOrEqual(minimum);
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
    const inline = collectInlineSchemas(api.paths);
    expect(inline.length).toBeGreaterThan(0);
    expect(() => instance.compile({
      $id: "openapi-inline",
      $defs: rewriteRefs(components.schemas),
      allOf: inline.map(rewriteRefs),
    })).not.toThrow();
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

  it("S3 1.4 runtime binding is optional for older peers and matches the standalone CP schema", () => {
    const api = load(block("s3-client-api")) as { info: { version: string }; components: { schemas: JsonObject } };
    expect(api.info.version).toBe("1.4.0");
    const instance = ajv();
    instance.addSchema({ $id: "s3-api", $defs: rewriteRefs(api.components.schemas) });
    const connect = instance.getSchema("s3-api#/$defs/ConnectResponse")!;
    const binding = instance.getSchema("s3-api#/$defs/RuntimeBinding")!;
    const fixture = JSON.parse(readFileSync(join(root, "scripts/__tests__/fixtures/s3-client-mixed-version.json"), "utf8"));
    for (const response of [fixture.legacy.connect, fixture.current.connect]) expect(connect(response), JSON.stringify(connect.errors)).toBe(true);
    const valid = fixture.current.connect.runtimeBinding;
    for (const [value, accepted] of [
      [valid, true], [{ ...valid, futureField: true }, true], [{}, false], [null, false],
      [{ ...valid, acceptedWorkVersion: 1 }, true], [{ ...valid, acceptedWorkVersion: 2 }, false],
      [{ ...valid, acceptedWorkVersion: null }, false], [{ ...valid, acceptedWorkVersion: "1" }, false],
      [{ ...valid, authorityEpoch: 0 }, false], [{ ...valid, authorityEpoch: Number.MAX_SAFE_INTEGER + 1 }, false],
      [{ ...valid, bootScope: { ...valid.bootScope, writerEpoch: "not-a-writer" } }, false],
      [{ ...valid, bootScope: { ...valid.bootScope, generation: 0 } }, false],
      [{ ...valid, bootScope: { ...valid.bootScope, fundingOwnerEpoch: 0 } }, false],
    ] as const) {
      expect(binding(value)).toBe(accepted);
      expect(CloudRuntimeBindingSchema.safeParse(value).success).toBe(accepted);
      expect(connect({ ...fixture.current.connect, runtimeBinding: value })).toBe(accepted);
    }
    // The prior client's open response shape ignores the new optional field.
    const oldSchemas = structuredClone(api.components.schemas) as Record<string, JsonObject>;
    delete (oldSchemas.ConnectResponse!.properties as JsonObject).runtimeBinding;
    delete oldSchemas.ConnectResponse!.if;
    delete oldSchemas.ConnectResponse!.then;
    const old = ajv().compile({ $defs: rewriteRefs(oldSchemas), $ref: "#/$defs/ConnectResponse" });
    expect(old(fixture.current.connect)).toBe(true);
    const withoutEngine = { ...fixture.current.connect };
    delete withoutEngine.engineInstanceId;
    expect(old(withoutEngine)).toBe(true);
    expect(connect(withoutEngine)).toBe(false);
    const priorSchemas = structuredClone(api.components.schemas) as Record<string, JsonObject>;
    delete (priorSchemas.RuntimeBinding!.properties as JsonObject).acceptedWorkVersion;
    const prior = ajv().compile({ $defs: rewriteRefs(priorSchemas), $ref: "#/$defs/ConnectResponse" });
    expect(prior({ ...fixture.current.connect, runtimeBinding: { ...valid, acceptedWorkVersion: 1 } })).toBe(true);
  });

  it("S3 1.3 ready coverage stays bounded, optional and compatible with older clients", () => {
    const schema = json("s3-device-stream-events");
    const instance = ajv();
    const ready = instance.compile(schema);
    const coverage = instance.compile({ $defs: schema.$defs, $ref: "#/$defs/organizationFeatures" });
    const fixture = JSON.parse(readFileSync(join(root, "scripts/__tests__/fixtures/s3-client-mixed-version.json"), "utf8"));
    for (const frame of [fixture.legacy.ready, fixture.current.ready]) expect(ready(frame), JSON.stringify(ready.errors)).toBe(true);
    const valid = fixture.current.ready.d.organizationFeatures;
    for (const [value, accepted] of [
      [valid, true], [[], true], [[{ ...valid[0], futureField: true }], true],
      [null, false], [[{ organizationId: valid[0].organizationId, deviceStream: true }], false],
      [[{ ...valid[0], organizationId: "foreign" }], false], [[{ ...valid[0], presence: "yes" }], false],
      [Array.from({ length: 1_001 }, () => valid[0]), false],
    ] as const) {
      expect(coverage(value)).toBe(accepted);
      expect(DeviceStreamOrganizationFeaturesSchema.safeParse(value).success).toBe(accepted);
      expect(ready({ ...fixture.current.ready, d: { ...fixture.current.ready.d, organizationFeatures: value } })).toBe(accepted);
    }
    const oldSchema = structuredClone(schema);
    const oldReady = (oldSchema.$defs as Record<string, JsonObject>)["server.ready"]!;
    delete (((oldReady.properties as JsonObject).d as JsonObject).properties as JsonObject).organizationFeatures;
    expect(ajv().compile(oldSchema)(fixture.current.ready)).toBe(true);
  });

  it("links only to files that exist, and anchors to headings that exist", () => {
    const docs = contractDocs();
    expect(docs).toEqual(["README.md", "s1-capabilities.md", "s2-uplink.md", "s3-client-contract.md"]);
    // The contracts README anchors are validated; the cloud README only gets
    // the file-exists check (its anchors target guides outside this suite).
    const sources = [...docs.map(doc => join(contracts, doc)), cloudReadme];
    for (const source of sources) {
      const prose = stripFences(readFileSync(source, "utf8"));
      const checkAnchors = dirname(source) === contracts;
      for (const [, target] of prose.matchAll(/\]\(([^)\s]+)\)/g)) {
        if (/^[a-z]+:/.test(target!)) continue;
        const [filePart, anchor] = target!.split("#", 2);
        const abs = filePart ? resolve(dirname(source), filePart) : source;
        expect(existsSync(abs), `${source} -> ${target}`).toBe(true);
        if (anchor && checkAnchors) {
          expect(headingSlugs(abs), `${source} -> ${target}`).toContain(anchor);
        }
      }
    }
  });

  it("cites repository paths that exist, with line ranges in bounds", () => {
    const sourcePath = /`((?:apps|packages|scripts|docs)\/[A-Za-z0-9_./-]+\.[A-Za-z0-9]+)((?::[0-9]+(?:-[0-9]+)?(?:,[0-9]+(?:-[0-9]+)?)*)?)`/g;
    const sources = [...contractDocs().map(doc => join(contracts, doc)), cloudReadme];
    let checked = 0;
    for (const source of sources) {
      const prose = stripFences(readFileSync(source, "utf8"));
      for (const [, path, spec] of prose.matchAll(sourcePath)) {
        const abs = join(root, path!);
        expect(existsSync(abs), `${source} cites ${path}`).toBe(true);
        checked += 1;
        if (!spec) continue;
        const lineCount = readFileSync(abs, "utf8").split("\n").length;
        for (const group of spec.slice(1).split(",")) {
          const [from, to] = group.split("-").map(Number);
          expect(from!, `${path}:${group}`).toBeGreaterThanOrEqual(1);
          expect(to ?? from!, `${path}:${group}`).toBeLessThanOrEqual(lineCount);
        }
      }
    }
    expect(checked, "no repository paths were checked").toBeGreaterThan(0);
  });
});
