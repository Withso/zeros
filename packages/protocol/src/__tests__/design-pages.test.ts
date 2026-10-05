import { describe, expect, it } from "vitest";
import {
  designPageCatalogSchema,
  designPageCreateInputSchema,
  designPageDeleteInputSchema,
  designPageRenameInputSchema,
} from "../design-pages";

describe("Design page operation boundaries", () => {
  it("accepts a default create and trims a valid authored title", () => {
    expect(designPageCreateInputSchema.parse({})).toEqual({});
    expect(
      designPageCreateInputSchema.parse({ title: "  Checkout  " }),
    ).toEqual({ title: "Checkout" });
    expect(
      designPageRenameInputSchema.parse({
        pageId: "checkout",
        title: "  Purchase  ",
      }),
    ).toEqual({ pageId: "checkout", title: "Purchase" });
  });

  it.each(["", " ", "a".repeat(121), "Bad\u0007title", "Bad\u0085title"])(
    "rejects invalid lifecycle titles: %j",
    (title) => {
      expect(designPageCreateInputSchema.safeParse({ title }).success).toBe(
        false,
      );
      expect(
        designPageRenameInputSchema.safeParse({ pageId: "checkout", title })
          .success,
      ).toBe(false);
    },
  );

  it("requires a distinct confirmed frame-ID set for destructive page removal", () => {
    expect(
      designPageDeleteInputSchema.parse({
        pageId: "checkout",
        expectedFrameIds: ["home", "summary"],
      }),
    ).toEqual({ pageId: "checkout", expectedFrameIds: ["home", "summary"] });
    for (const input of [
      { pageId: "checkout" },
      { pageId: "checkout", expectedFrameIds: ["home", "home"] },
      { pageId: "checkout", expectedFrameIds: ["checkout/home.html"] },
    ])
      expect(designPageDeleteInputSchema.safeParse(input).success).toBe(false);
  });

  it("rejects case aliases in a wire page catalog", () => {
    expect(
      designPageCatalogSchema.safeParse([
        { id: "one", title: "One", folder: "Checkout", frameFiles: [] },
        { id: "two", title: "Two", folder: "checkout", frameFiles: [] },
      ]).success,
    ).toBe(false);
  });

  it("retains optional registered IDs even when a frame cannot render", () => {
    const page = {
      id: "one",
      title: "One",
      folder: "page-1",
      frameFiles: ["page-1/missing.html"],
      frameIds: ["missing"],
    };
    expect(designPageCatalogSchema.parse([page])).toEqual([page]);
    expect(
      designPageCatalogSchema.safeParse([{ ...page, frameIds: [] }]).success,
    ).toBe(false);
    expect(
      designPageCatalogSchema.safeParse([{ ...page, frameIds: ["bad/id"] }])
        .success,
    ).toBe(false);
    expect(
      designPageCatalogSchema.safeParse([
        page,
        {
          id: "two",
          title: "Two",
          folder: "two",
          frameFiles: ["two/home.html"],
          frameIds: ["missing"],
        },
      ]).success,
    ).toBe(false);
  });
});
