import { describe, expect, it } from "vitest";
import { safeToolImageSource } from "../tool-artwork";
describe("tool artwork image boundary", () => {
  it.each([
    "file:///tmp/image.png",
    "javascript:alert(1)",
    "https://user:password@example.com/image.png",
    "https://localhost/icon.png",
    "https://127.0.0.1/icon",
    "https://[::1]/icon",
    "https://router.internal/icon",
    "data:text/html;base64,aA==",
  ])("rejects %s", (value) =>
    expect(safeToolImageSource(value)).toBeUndefined(),
  );
  it("accepts provider HTTPS artwork and bounded raster data", () => {
    expect(safeToolImageSource("https://cdn.example.com/icon.svg")).toBe(
      "https://cdn.example.com/icon.svg",
    );
    expect(safeToolImageSource("data:image/png;base64,aA==")).toBe(
      "data:image/png;base64,aA==",
    );
    expect(
      safeToolImageSource("data:image/png;base64," + "A".repeat(100_000)),
    ).toBeUndefined();
  });
  it("allows passive SVG artwork but refuses executable or external content", () => {
    const data = (svg: string) => `data:image/svg+xml;base64,${btoa(svg)}`;
    const icon = data(
      '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0" /></svg>',
    );
    expect(safeToolImageSource(icon)).toBe(icon);
    for (const content of [
      "<script>alert(1)</script>",
      '<image href="https://example.com/private"/>',
      '<use href="file:///secret"/>',
      '<set attributeName="href" to="javascript:alert(1)"/>',
      '<path onload="alert(1)"/>',
    ]) {
      expect(
        safeToolImageSource(data(`<svg>${content}</svg>`)),
      ).toBeUndefined();
    }
  });
});
