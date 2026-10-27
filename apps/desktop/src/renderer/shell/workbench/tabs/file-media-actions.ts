const MAX_COPY_PIXELS = 32 * 1024 * 1024;

/** The clipboard accepts PNG across platforms. Keep original PNG bytes when
 * possible; other formats and video frames need one temporary, on-demand canvas.
 * Neither zoom nor pan changes the copied pixels. */
export async function copyFileMediaImage(
  media: HTMLImageElement | HTMLVideoElement,
  source: string,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") {
    throw new Error("Image copying is unavailable. Download the file instead.");
  }
  const video = media.tagName === "VIDEO" ? (media as HTMLVideoElement) : null;
  const width = video
    ? video.videoWidth
    : (media as HTMLImageElement).naturalWidth;
  const height = video
    ? video.videoHeight
    : (media as HTMLImageElement).naturalHeight;
  if (!width || !height || (video && video.readyState < 2))
    throw new Error("Wait for the preview to load, then try again.");
  if (width * height > MAX_COPY_PIXELS)
    throw new Error(
      "This image is too large to copy. Download the original instead.",
    );

  const png =
    !video && source.startsWith("data:image/png;base64,")
      ? Promise.resolve(originalPng(source))
      : capturePng(media, width, height, signal);
  // Start the clipboard write in the click's activation, before encoding. A
  // retired owner rejects its pending blob instead of copying a different file.
  void png.catch(() => {});
  await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
  signal.throwIfAborted();
}

function originalPng(source: string): Blob {
  // Packaged CSP disallows data: connections. Decode the already bounded read
  // directly instead of fetch(data:) or allocating a full-resolution canvas.
  const binary = atob(source.slice("data:image/png;base64,".length));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: "image/png" });
}

async function capturePng(
  media: HTMLImageElement | HTMLVideoElement,
  width: number,
  height: number,
  signal: AbortSignal,
): Promise<Blob> {
  const canvas = document.createElement("canvas");
  try {
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context)
      throw new Error(
        "The preview could not be copied. Download the original instead.",
      );
    context.drawImage(media, 0, 0, width, height);
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/png"),
    );
    signal.throwIfAborted();
    if (!blob)
      throw new Error(
        "The preview could not be copied. Download the original instead.",
      );
    return blob;
  } finally {
    // Release the full-resolution bitmap as soon as its encoded result exists.
    canvas.width = canvas.height = 0;
  }
}
