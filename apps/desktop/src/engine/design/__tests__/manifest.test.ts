import { describe, expect, it } from "vitest";
import { parseDesignManifest, serializeDesignManifest } from "../manifest";

describe("portable Design manifest", () => {
  it("round trips JSON metadata, including nulls and extension fields", () => {
    const document = JSON.parse(
      '{"version":3,"frames":{},"frame_info":{},"foundation":{"parameters":[{"default":null}]},"extra":{"a/b~c":[null,{"__proto__":null}],"empty":{},"list":[],"text":"","flag":false}}',
    );
    const source = serializeDesignManifest("design_example", document);
    expect(source).toContain('format = "zeros-design"');
    expect(parseDesignManifest(source)).toEqual({
      id: "design_example",
      document,
    });
  });

  it("does not identify another application's design.toml as a Design folder", () => {
    expect(parseDesignManifest('name = "website"')).toBeNull();
    expect(parseDesignManifest("invalid unrelated toml [[[")).toBeNull();
  });

  it("rejects damaged Zeros manifests and unsafe null references", () => {
    expect(() =>
      parseDesignManifest('format = "zeros-design"\nversion = 9'),
    ).toThrow();
    const source = serializeDesignManifest("design_example", {
      version: 3,
      value: null,
    });
    expect(() =>
      parseDesignManifest(source.replace("/value", "/missing")),
    ).toThrow();
    expect(() =>
      parseDesignManifest(source.replace("/value", "/__proto__/polluted")),
    ).toThrow();
    expect(() => serializeDesignManifest("../bad", {})).toThrow();
  });
});
