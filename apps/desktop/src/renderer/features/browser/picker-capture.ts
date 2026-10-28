import type { SelectedElement } from "./use-iframe-webview";

/** Keep selection metadata immediate and bound optional thumbnails. Duplicate
 * rectangles share one capture; a retired page must start no more native work. */
export async function capturePickerSelection(
  elements: readonly SelectedElement[],
  capture: (rect: SelectedElement["rect"]) => Promise<string | undefined>,
  current: () => boolean,
): Promise<SelectedElement[]> {
  const images = new Map<string, string | undefined>();
  const result: SelectedElement[] = [];
  let attempts = 0, pixels = 0, retainedBytes = 0;
  for (const element of elements) {
    if (!current()) return [];
    const { x, y, width, height } = element.rect;
    const key = `${x},${y},${width},${height}`;
    if (!images.has(key) && attempts < 8 && pixels + width * height <= 4_000_000 && retainedBytes < 4 * 1024 * 1024) {
      attempts++;
      pixels += width * height;
      const image = await capture(element.rect);
      if (!current()) return [];
      const withinLimit = typeof image === "string" && image.length <= 2 * 1024 * 1024 && retainedBytes + image.length <= 4 * 1024 * 1024;
      images.set(key, withinLimit ? image : undefined);
    }
    const image = images.get(key);
    const screenshot = image && retainedBytes + image.length <= 4 * 1024 * 1024 ? image : undefined;
    if (screenshot) retainedBytes += screenshot.length;
    result.push({ ...element, screenshot });
  }
  return result;
}
