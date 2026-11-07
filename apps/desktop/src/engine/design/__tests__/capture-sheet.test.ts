import { expect, it } from "vitest";
import { designCaptureRasterSize } from "@zeros/protocol/design-capture";
import {
  DESIGN_CAPTURE_SHEET_READY_SCRIPT,
  designCaptureSheetDocument,
  layoutDesignCaptureSheets,
} from "../capture-sheet";

const item = (id: string, width: number, height: number, maxDimension = 128) =>
  ({ id, html: `<html><head></head><body>${id}</body></html>`, viewport: { width, height }, maxDimension });

it("packs pictures in request order at their exact single-capture raster size, within bounded sheets", () => {
  const items = Array.from({ length: 120 }, (_, index) => item(`f${index}`, 1440, index % 2 ? 900 : 1400));
  const sheets = layoutDesignCaptureSheets(items, 1024, 50);
  expect(sheets.map(sheet => sheet.cells.length)).toEqual([50, 50, 20]);
  expect(sheets.flatMap(sheet => sheet.cells.map(cell => cell.id))).toEqual(items.map(entry => entry.id));
  for (const sheet of sheets) {
    expect(sheet.width).toBeLessThanOrEqual(1024);
    expect(sheet.height).toBeLessThanOrEqual(1024);
    for (const cell of sheet.cells) {
      const source = items.find(entry => entry.id === cell.id)!;
      expect({ width: cell.width, height: cell.height }).toEqual(
        (({ width, height }) => ({ width, height }))(designCaptureRasterSize(source.viewport, source.maxDimension)));
      expect(cell.x + cell.width).toBeLessThanOrEqual(sheet.width);
      expect(cell.y + cell.height).toBeLessThanOrEqual(sheet.height);
    }
    // No two pictures overlap.
    for (const a of sheet.cells) for (const b of sheet.cells) if (a !== b)
      expect(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y).toBe(true);
  }
  // A fractional canvas size lays out at whole pixels, as a single capture does.
  expect(layoutDesignCaptureSheets([item("x", 1039.5, 720.25)])[0]!.cells[0]!.viewport).toEqual({ width: 1040, height: 721 });
});

it("builds a sheet of sandboxed, script-free frame documents that paint their exact picture rectangle", () => {
  const items = [item("a", 1440, 900), { ...item("b", 1040, 720), html: "<html><head></head><body><script>alert(1)</script><p onclick=\"x()\">B</p></body></html>" }];
  const [sheet] = layoutDesignCaptureSheets(items);
  const html = designCaptureSheetDocument(sheet!, new Map(items.map(entry => [entry.id, entry])), "dark", 2);
  const frames = [...html.matchAll(/<iframe ([\s\S]*?)><\/iframe>/g)].map(match => match[1]!);
  expect(frames).toHaveLength(2);
  for (const frame of frames) {
    expect(frame).toContain('sandbox="allow-same-origin"');
    expect(frame).not.toContain("allow-scripts");
    expect(frame).toContain("script-src 'none'");
    expect(frame).toContain("color-scheme:dark");
  }
  expect(html).not.toContain("<script>alert(1)</script>");
  expect(html).not.toContain("onclick");
  // 1440 CSS px painted as 128 device px at a device pixel ratio of 2.
  expect(frames[0]).toContain(`transform:scale(${128 / (1440 * 2)})`);
  expect(html).toContain(`width:${128 / 2}px`);
  // The readiness check stills timelines in each frame and waits for paint.
  expect(DESIGN_CAPTURE_SHEET_READY_SCRIPT).toContain("stillAuthoredTimelines");
  expect(DESIGN_CAPTURE_SHEET_READY_SCRIPT).toContain("requestAnimationFrame");
});
