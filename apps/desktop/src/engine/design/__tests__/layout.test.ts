import { describe, expect, it } from "vitest";
import { resolveDesignManifestLayout } from "../layout";
import {
  parseDesignManifest,
  serializeDesignManifest,
  serializeDesignRegistration,
} from "../manifest";

describe("pure Design layout resolution", () => {
  it.each([2, 3] as const)(
    "resolves manifest v%s beside its canvas",
    (version) => {
      const file =
        version === 3
          ? "apps/Product/meta/design.toml"
          : "apps/Product/design.toml";
      const manifest = parseDesignManifest(
        serializeDesignRegistration("design_product", version),
      )!;
      expect(resolveDesignManifestLayout(file, manifest)).toEqual({
        directory: "apps/Product",
        kind: version === 3 ? "meta-v3" : "root-v2",
        manifestFile: file,
        documentFile:
          version === 3
            ? "apps/Product/meta/canvas.json"
            : "apps/Product/canvas.json",
        rulesFile: "apps/Product/rules.md",
        canvasVersion: version === 3 ? 2 : 1,
      });
    },
  );

  it("retains inline v1 layout", () => {
    const manifest = parseDesignManifest(
      serializeDesignManifest("design_old", { frames: {} }),
    )!;
    expect(
      resolveDesignManifestLayout("Product/design.toml", manifest),
    ).toMatchObject({
      directory: "Product",
      kind: "inline-v1",
      documentFile: "Product/design.toml",
    });
  });

  it.each([
    "Product/design.toml",
    "Product/Meta/design.toml",
    "meta/design.toml",
    "../Product/meta/design.toml",
    "/Product/meta/design.toml",
  ])("rejects a misplaced v3 manifest: %s", (file) => {
    const manifest = parseDesignManifest(
      serializeDesignRegistration("design_product", 3),
    )!;
    expect(() => resolveDesignManifestLayout(file, manifest)).toThrow();
  });
});
