import { readFileSync } from "node:fs";

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";

import {
  generateDeviceStreamTypes,
  generateRestTypes,
  generateRuntimeAuthTypes,
} from "../../scripts/generate-types.mjs";
import {
  loadContractSchemas,
  openApiComponentSchema,
} from "../contract-source";
import {
  DEVICE_STREAM_FIXTURES,
  REST_FIXTURES,
  RUNTIME_AUTH_FIXTURES,
} from "./fixtures";

const schemas = loadContractSchemas();

function ajv() {
  // Frame schemas compose a shared envelope through allOf, which ajv's
  // strictRequired/strictTypes checks cannot see across (mirrors
  // scripts/__tests__/cloud-contract-schemas.test.ts).
  const instance = new Ajv2020({
    strict: true,
    strictTypes: false,
    strictRequired: false,
    allErrors: true,
  });
  addFormats(instance);
  return instance;
}

type JsonObject = Record<string, unknown>;

/** Map a frame type constant ("catalog.changed") to its $defs key. */
function defKeyByType(schema: JsonObject): Map<string, string> {
  const defs = schema.$defs as Record<string, JsonObject>;
  const map = new Map<string, string>();
  for (const [key, def] of Object.entries(defs)) {
    const t = (def.properties as JsonObject | undefined)?.t as
      | { const?: string }
      | undefined;
    if (t?.const) map.set(t.const, key);
  }
  return map;
}

function frameValidator(schema: JsonObject, type: string) {
  const key = defKeyByType(schema).get(type);
  if (!key) throw new Error(`no $defs entry carries t=${type}`);
  return ajv().compile({ $defs: schema.$defs, $ref: `#/$defs/${key}` });
}

describe("generated S3 types", () => {
  it("are current with the frozen contract schemas", () => {
    const check = (generated: string, file: string) => {
      const onDisk = readFileSync(
        new URL(`../generated/${file}`, import.meta.url),
        "utf8",
      );
      if (generated !== onDisk) {
        expect.soft(generated, `${file} is stale; run pnpm --dir packages/cloud-client generate`).toBe(onDisk);
      }
    };
    check(generateRestTypes(schemas.openApi), "rest.ts");
    check(generateDeviceStreamTypes(schemas.deviceStream), "device-stream.ts");
    check(generateRuntimeAuthTypes(schemas.runtimeAuth), "runtime-auth.ts");
  });

  it("round-trips every device-stream event fixture against the markdown schema", () => {
    for (const [type, frame] of Object.entries(DEVICE_STREAM_FIXTURES)) {
      const validate = frameValidator(schemas.deviceStream, type);
      expect(
        validate(frame),
        `${type}: ${JSON.stringify(validate.errors)}`,
      ).toBe(true);
    }
  });

  it("round-trips every device-stream example shipped in the contract", () => {
    const examples = schemas.deviceStream.examples as JsonObject[];
    expect(examples.length).toBeGreaterThan(0);
    for (const example of examples) {
      const validate = frameValidator(schemas.deviceStream, example.t as string);
      expect(
        validate(example),
        `${example.t}: ${JSON.stringify(validate.errors)}`,
      ).toBe(true);
    }
  });

  it("round-trips every runtime auth frame fixture and contract example", () => {
    for (const [type, frame] of Object.entries(RUNTIME_AUTH_FIXTURES)) {
      const validate = frameValidator(schemas.runtimeAuth, type);
      expect(
        validate(frame),
        `${type}: ${JSON.stringify(validate.errors)}`,
      ).toBe(true);
    }
    for (const example of schemas.runtimeAuth.examples as JsonObject[]) {
      const validate = frameValidator(schemas.runtimeAuth, example.t as string);
      expect(
        validate(example),
        `${example.t}: ${JSON.stringify(validate.errors)}`,
      ).toBe(true);
    }
  });

  it("round-trips every REST schema fixture against the OpenAPI components", () => {
    const validator = ajv();
    for (const [name, value] of Object.entries(REST_FIXTURES)) {
      const schema = openApiComponentSchema(schemas.openApi, name);
      const validate = validator.compile(schema);
      expect(
        validate(value),
        `${name}: ${JSON.stringify(validate.errors)}`,
      ).toBe(true);
    }
  });

  it("rejects a fixture that breaks the schema (guard the guard)", () => {
    const validate = frameValidator(schemas.deviceStream, "catalog.changed");
    expect(
      validate({
        t: "catalog.changed",
        c: "c-9",
        d: { workspaceId: "not-a-uuid", version: 1, catalogVersion: 1, op: "upsert" },
      }),
    ).toBe(false);
  });
});
