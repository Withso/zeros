// The pictures that stand for a saved capture: the thumbnail the Simulator
// tab shows and the icon under the pointer while it is dragged out.

import type { NativeImage, nativeImage as NativeImageModule } from "electron";

import type { SavedCapture } from "./simulator-captures";

export type CaptureImages = Pick<
  typeof NativeImageModule,
  "createFromPath" | "createFromDataURL" | "createFromBitmap"
>;

/** The thumbnail's longest edge, in pixels: sharp at twice its drawn size. */
export const CAPTURE_THUMBNAIL_EDGE = 360;
const DRAG_ICON_EDGE = 96;
const PLAIN_ICON_EDGE = 32;

function fit(image: NativeImage, edge: number): NativeImage {
  const { width, height } = image.getSize();
  if (Math.max(width, height) <= edge) return image;
  return image.resize(width >= height ? { width: edge } : { height: edge });
}

/** A PNG data URL of a screenshot file, small enough for a thumbnail. */
export function captureThumbnail(images: CaptureImages, png: string): string | null {
  const image = images.createFromPath(png);
  return image.isEmpty() ? null : fit(image, CAPTURE_THUMBNAIL_EDGE).toDataURL();
}

/** macOS refuses a drag without an icon, so one is always made. */
export function captureDragIcon(images: CaptureImages, saved: SavedCapture): NativeImage {
  const { capture } = saved;
  const picture = capture.thumbnail
    ? images.createFromDataURL(capture.thumbnail)
    : capture.kind === "screenshot"
      ? images.createFromPath(saved.path)
      : null;
  if (picture && !picture.isEmpty()) return fit(picture, DRAG_ICON_EDGE);
  return images.createFromBitmap(Buffer.alloc(PLAIN_ICON_EDGE * PLAIN_ICON_EDGE * 4, 0x80), {
    width: PLAIN_ICON_EDGE,
    height: PLAIN_ICON_EDGE,
  });
}
