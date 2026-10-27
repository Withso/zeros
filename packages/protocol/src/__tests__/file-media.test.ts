import { describe, expect, it } from "vitest";
import { fileMediaType, MAX_FILE_MEDIA_BYTES, parseFileMediaRange } from "../file-media";

describe("streamed media contract", () => {
  it.each(["clip.constructor", "clip.__proto__", "clip.txt", "clip"])("does not treat %s as a supported media extension", path => {
    expect(fileMediaType(path)).toBeNull();
  });
  it("accepts supported extensions without depending on case", () => {
    expect(fileMediaType("screenshots/photo.AVIF")).toEqual({ kind: "image", mimeType: "image/avif" });
    expect(fileMediaType("clips/demo.MP4")).toEqual({ kind: "video", mimeType: "video/mp4" });
  });
  it("keeps complete open-ended ranges for playback and supports suffix seeking", () => {
    expect(parseFileMediaRange("bytes=1024-", MAX_FILE_MEDIA_BYTES)).toEqual({ start: 1024, end: MAX_FILE_MEDIA_BYTES - 1, partial: true });
    expect(parseFileMediaRange("bytes=-64", 1000)).toEqual({ start: 936, end: 999, partial: true });
    expect(parseFileMediaRange("bytes=0-2048", 1000)).toEqual({ start: 0, end: 999, partial: true });
    expect(parseFileMediaRange(null, 0)).toEqual({ start: 0, end: -1, partial: false });
  });
  it.each(["bytes=1000-", "bytes=2-1", "bytes=0-1,3-4", "bytes=-0", "bytes=-", "bytes=9007199254740993-"])("rejects unsatisfiable range %s", range => {
    expect(parseFileMediaRange(range, 1000)).toBeNull();
  });
});
