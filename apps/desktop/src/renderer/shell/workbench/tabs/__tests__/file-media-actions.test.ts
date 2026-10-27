import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { copyFileMediaImage } from "../file-media-actions";

describe("Files media clipboard boundary", () => {
  let write: ReturnType<typeof vi.fn>, copied: Blob | undefined;
  let canvas: {
    width: number;
    height: number;
    getContext: ReturnType<typeof vi.fn>;
    toBlob: ReturnType<typeof vi.fn>;
  };
  let encode: ((blob: Blob | null) => void) | undefined;
  const drawImage = vi.fn();
  const image = {
    tagName: "IMG",
    naturalWidth: 320,
    naturalHeight: 180,
  } as HTMLImageElement;
  const video = {
    tagName: "VIDEO",
    videoWidth: 640,
    videoHeight: 360,
    readyState: 2,
  } as HTMLVideoElement;
  beforeEach(() => {
    copied = undefined;
    encode = undefined;
    drawImage.mockClear();
    canvas = {
      width: 0,
      height: 0,
      getContext: vi.fn(() => ({ drawImage })),
      toBlob: vi.fn((callback) => {
        encode = callback;
      }),
    };
    vi.stubGlobal("document", { createElement: vi.fn(() => canvas) });
    vi.stubGlobal(
      "ClipboardItem",
      class {
        constructor(readonly data: Record<string, Promise<Blob>>) {}
      },
    );
    write = vi.fn(async (items: { data: Record<string, Promise<Blob>> }[]) => {
      copied = await items[0].data["image/png"];
    });
    vi.stubGlobal("navigator", { clipboard: { write } });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("copies original PNG bytes without a bitmap or a fetch blocked by packaged CSP", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("data: fetch blocked by connect-src");
      }),
    );
    await copyFileMediaImage(
      image,
      "data:image/png;base64,b3JpZ2luYWwgZml4dHVyZQ==",
      new AbortController().signal,
    );
    expect(await copied?.text()).toBe("original fixture");
    expect(copied?.type).toBe("image/png");
    expect(fetch).not.toHaveBeenCalled();
    expect(document.createElement).not.toHaveBeenCalled();
  });

  it.each([image, video])(
    "copies native pixels and releases the temporary canvas (%j)",
    async (media) => {
      const operation = copyFileMediaImage(
        media,
        "data:image/webp;base64,fixture",
        new AbortController().signal,
      );
      expect(write).toHaveBeenCalledTimes(1); // Write starts before encoding completes.
      expect(canvas.width).toBe(media === image ? 320 : 640);
      expect(canvas.height).toBe(media === image ? 180 : 360);
      const png = new Blob(["encoded fixture"], { type: "image/png" });
      encode!(png);
      await operation;
      expect(copied).toBe(png);
      expect(drawImage).toHaveBeenCalledWith(
        media,
        0,
        0,
        media === image ? 320 : 640,
        media === image ? 180 : 360,
      );
      expect([canvas.width, canvas.height]).toEqual([0, 0]);
    },
  );

  it("rejects a held frame after owner retirement and frees its bitmap", async () => {
    const controller = new AbortController();
    const operation = copyFileMediaImage(
      video,
      "data:video/webm;base64,fixture",
      controller.signal,
    );
    const rejection = expect(operation).rejects.toMatchObject({
      name: "AbortError",
    });
    controller.abort();
    encode!(new Blob(["frame"], { type: "image/png" }));
    await rejection;
    expect(copied).toBeUndefined();
    expect([canvas.width, canvas.height]).toEqual([0, 0]);
  });

  it("fails a decode/encoder refusal without leaving an allocated canvas", async () => {
    const operation = copyFileMediaImage(
      image,
      "data:image/jpeg;base64,fixture",
      new AbortController().signal,
    );
    const rejection = expect(operation).rejects.toThrow("could not be copied");
    encode!(null);
    await rejection;
    expect([canvas.width, canvas.height]).toEqual([0, 0]);
  });

  it("bounds copy allocation and refuses frames that have not decoded", async () => {
    await expect(
      copyFileMediaImage(
        { ...image, naturalWidth: 1_000_000 } as HTMLImageElement,
        "data:image/png;base64,fixture",
        new AbortController().signal,
      ),
    ).rejects.toThrow("too large to copy");
    await expect(
      copyFileMediaImage(
        { ...video, readyState: 1 } as HTMLVideoElement,
        "data:video/webm;base64,fixture",
        new AbortController().signal,
      ),
    ).rejects.toThrow("Wait for the preview");
    expect(document.createElement).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it("reports unavailable clipboard permission without starting conversion", async () => {
    vi.stubGlobal("navigator", {});
    await expect(
      copyFileMediaImage(
        image,
        "data:image/webp;base64,fixture",
        new AbortController().signal,
      ),
    ).rejects.toThrow("Download the file instead");
    expect(document.createElement).not.toHaveBeenCalled();
  });
});
