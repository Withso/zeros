import { describe, expect, it } from "vitest";
import {
  designFrameFileSchema,
  encodeDesignFramePath,
  isDesignFrameFile,
  isDesignPageFolder,
  portableDesignName,
} from "../design-path";
import { designContextReferenceSchema } from "../design-context";

describe("Design frame paths", () => {
  it.each(["home.html", "Page.v2/Home.HTML"])(
    "keeps path separators and authored spelling in frame URLs: %s",
    (file) => {
      const base = "zeros-design://workspace/workspace/capability/";
      const url = new URL(`${base}${encodeDesignFramePath(file)}`);
      expect(url.pathname).toBe(`/workspace/capability/${file}`);
    },
  );

  it("compares case and Unicode aliases without changing source identity", () => {
    const authored = "Cafe\u0301/Checkout.HTML";
    expect(portableDesignName(authored)).toBe(
      portableDesignName("CAFÉ/checkout.html"),
    );
    expect(authored).toBe("Cafe\u0301/Checkout.HTML");
    expect(portableDesignName("page-b")).not.toBe(
      portableDesignName("page-beta"),
    );
  });

  it.each([
    "home.html",
    "Home.v2.HTML",
    "page-1/home.html",
    "checkout/home.html",
    "Checkout/home.html",
    "login_page/home.html",
    "Page.v2/Home.HTML",
  ])("accepts the exact portable source path %s", (file) => {
    expect(isDesignFrameFile(file)).toBe(true);
    expect(designFrameFileSchema.parse(file)).toBe(file);
    expect(
      designContextReferenceSchema.parse({
        version: 1,
        workspaceId: "workspace",
        directoryId: "design",
        frame: file,
        revision: "a".repeat(24),
      }).frame,
    ).toBe(file);
  });

  it.each([
    "../home.html",
    "/home.html",
    "page/../home.html",
    "page/sub/home.html",
    "page\\home.html",
    "page%2fhome.html",
    "page/%68ome.html",
    ".hidden/home.html",
    "meta/home.html",
    "assets/home.html",
    "components/home.html",
    "META/home.html",
    "Assets/home.html",
    "Components/home.html",
    "page./home.html",
    "page//home.html",
    "page/.home.html",
    "home.html?x=1",
    "home.html#x",
    "home.html\n",
    `${"p".repeat(65)}/home.html`,
    null,
    1,
  ])("rejects aliases, reserved folders and unsafe paths: %j", (file) => {
    expect(isDesignFrameFile(file)).toBe(false);
    expect(designFrameFileSchema.safeParse(file).success).toBe(false);
  });

  it.each(["Checkout", "login_page", "Page.v2", "A_", "p".repeat(64)])(
    "accepts portable authored page folder %s",
    (folder) => {
      expect(isDesignPageFolder(folder)).toBe(true);
    },
  );

  it.each([
    "meta",
    "META",
    "Assets",
    "COMPONENTS",
    "page.",
    ".page",
    "page/child",
    "page\\child",
    "p".repeat(65),
    "page ",
    "page\n",
  ])("rejects unsafe or reserved page folder %s", (folder) => {
    expect(isDesignPageFolder(folder)).toBe(false);
  });
});
