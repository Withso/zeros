import { describe, expect, it } from "vitest";
import { designFrameFileSchema, isDesignFrameFile } from "../design-path";
import { designContextReferenceSchema } from "../design-context";

describe("Design frame paths", () => {
  it.each(["home.html", "Home.v2.HTML", "page-1/home.html", "checkout/home.html"])(
    "accepts the exact portable source path %s",
    (file) => {
      expect(isDesignFrameFile(file)).toBe(true);
      expect(designFrameFileSchema.parse(file)).toBe(file);
      expect(designContextReferenceSchema.parse({
        version: 1, workspaceId: "workspace", directoryId: "design",
        frame: file, revision: "a".repeat(24),
      }).frame).toBe(file);
    },
  );

  it.each([
    "../home.html", "/home.html", "page/../home.html", "page/sub/home.html",
    "page\\home.html", "page%2fhome.html", "page/%68ome.html", ".hidden/home.html",
    "meta/home.html", "assets/home.html", "components/home.html", "Page/home.html",
    "page_/home.html", "page//home.html", "page/.home.html", "home.html?x=1",
    "home.html#x", "home.html\n", `${"p".repeat(65)}/home.html`, null, 1,
  ])("rejects aliases, reserved folders and unsafe paths: %j", (file) => {
    expect(isDesignFrameFile(file)).toBe(false);
    expect(designFrameFileSchema.safeParse(file).success).toBe(false);
  });
});
