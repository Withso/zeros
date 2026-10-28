import { describe, expect, it } from "vitest";
import { buildElectronRendererCsp } from "../../vite.config";

describe("packaged file preview policy", () => {
  it("permits native media sources without enabling executable embeds", () => {
    const directives = new Map(
      buildElectronRendererCsp("")
        .split("; ")
        .map((value) => {
          const [name, ...sources] = value.split(" ");
          return [name, sources];
        }),
    );
    expect(directives.get("img-src")).toContain("zeros-media:");
    expect(directives.get("media-src")).toContain("zeros-media:");
    expect(directives.get("object-src")).toEqual(["'none'"]);
    expect(directives.get("script-src")).not.toContain("zeros-media:");
  });
});
