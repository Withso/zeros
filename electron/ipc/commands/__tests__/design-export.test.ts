import { describe, expect, it } from "vitest";

import {
  decodeDesignPng,
  designPngSaveDialogOptions,
  designPngSuggestedName,
} from "../design-export";

describe("design PNG export", () => {
  it("accepts a bounded PNG payload and normalizes the suggested name", () => {
    const png = Buffer.concat([
      Buffer.from("89504e470d0a1a0a", "hex"),
      Buffer.from("pixels"),
    ]);
    expect(decodeDesignPng(png.toString("base64"))).toEqual(png);
    expect(designPngSuggestedName("Pricing / Desktop.html")).toBe(
      "Pricing - Desktop.png",
    );
  });

  it("uses only save-dialog options", () => {
    expect(designPngSaveDialogOptions("Frame.png")).toEqual({
      title: "Export design as PNG",
      defaultPath: "Frame.png",
      filters: [{ name: "PNG image", extensions: ["png"] }],
    });
  });

  it("rejects malformed base64, non-PNG bytes, and oversized payloads", () => {
    expect(() => decodeDesignPng("not base64!")).toThrow(/base64/i);
    expect(() =>
      decodeDesignPng(Buffer.from("not a png").toString("base64")),
    ).toThrow(/PNG/i);
    expect(() =>
      decodeDesignPng(Buffer.alloc(12 * 1024 * 1024 + 1).toString("base64")),
    ).toThrow(/large/i);
  });
});
