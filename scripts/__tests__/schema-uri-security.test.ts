import Ajv from "ajv";
import { describe, expect, it } from "vitest";

// Exercise AJV's installed resolver, also used by the MCP SDK, so a
// dependency resolution change cannot silently restore these unsafe inputs.
describe("schema URI authority validation", () => {
  const resolver = new Ajv().opts.uriResolver;

  it.each(["@other.example.test:443", "443/other", "443#other"])(
    "rejects authority delimiters in the port: %s",
    (port) => {
      expect(() =>
        resolver.serialize({
          scheme: "https",
          host: "schemas.example.test",
          port,
          path: "/schema",
        }),
      ).toThrow();
    },
  );

  it.each([
    "https://[schemas.example.test/schema",
    "https://schemas.example.test]/schema",
  ])("reports an invalid bracketed authority: %s", (uri) => {
    expect(resolver.parse(uri).error).toBeTruthy();
  });

  it("preserves valid ports and IPv6 authorities", () => {
    expect(
      resolver.serialize({
        scheme: "https",
        host: "schemas.example.test",
        port: 8443,
        path: "/schema",
      }),
    ).toBe("https://schemas.example.test:8443/schema");
    const parsed = resolver.parse("https://[2001:db8::1]:8443/schema");
    expect(parsed).toMatchObject({ host: "2001:db8::1", port: 8443 });
    expect(parsed.error).toBeUndefined();
  });

  it("resolves relative schema references without changing validation", () => {
    const ajv = new Ajv();
    ajv.addSchema({
      $id: "https://schemas.example.test:8443/catalog/types/item.json",
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
      additionalProperties: false,
    });
    const validate = ajv.compile({
      $id: "https://schemas.example.test:8443/catalog/",
      $ref: "types/item.json",
    });

    expect(validate({ name: "item" })).toBe(true);
    expect(validate({ name: 42 })).toBe(false);
    expect(validate({})).toBe(false);
  });
});
