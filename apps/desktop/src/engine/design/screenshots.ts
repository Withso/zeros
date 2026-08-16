// ──────────────────────────────────────────────────────────
// Design screenshot registry
// ──────────────────────────────────────────────────────────
//
// Sandboxed renderer runtimes capture real frame pixels and publish them here.
// The trusted desktop bridge can then export those pixels without giving the
// renderer filesystem paths or native write authority.

const MAX_SCREENSHOTS = 64;
const MAX_BASE64_LENGTH = 12_000_000;
const ALLOWED_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

export interface DesignScreenshot {
  workspaceId: string;
  frame: string;
  nodeId: string | null;
  mimeType: "image/png" | "image/jpeg" | "image/webp";
  data: string;
  width: number;
  height: number;
  scale: number;
  capturedAt: number;
  /** Exact rendered HTML/CSS/viewport generation in these pixels. */
  sourceVersion: string;
}

const screenshots = new Map<string, DesignScreenshot>();

function screenshotKey(
  workspaceId: string,
  frame: string,
  nodeId: string | null,
): string {
  return `${workspaceId}\u0000${frame}\u0000${nodeId ?? ""}`;
}

function finitePositive(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} must be a positive finite number.`);
  }
  return value;
}

function hasPrefix(bytes: Buffer, prefix: Buffer): boolean {
  return (
    bytes.length >= prefix.length &&
    bytes.subarray(0, prefix.length).equals(prefix)
  );
}

function assertImageSignature(
  mimeType: DesignScreenshot["mimeType"],
  data: string,
): void {
  const bytes = Buffer.from(data, "base64");
  if (bytes.length === 0 || bytes.toString("base64") !== data) {
    throw new Error("Design screenshot data must be canonical base64.");
  }

  if (mimeType === "image/png" && !hasPrefix(bytes, PNG_SIGNATURE)) {
    throw new Error("Design screenshot data is not a PNG image.");
  }
  if (
    mimeType === "image/jpeg" &&
    !(
      bytes.length >= 4 &&
      bytes[0] === 0xff &&
      bytes[1] === 0xd8 &&
      bytes.at(-2) === 0xff &&
      bytes.at(-1) === 0xd9
    )
  ) {
    throw new Error("Design screenshot data is not a JPEG image.");
  }
  if (
    mimeType === "image/webp" &&
    !(
      bytes.length >= 12 &&
      bytes.toString("ascii", 0, 4) === "RIFF" &&
      bytes.toString("ascii", 8, 12) === "WEBP"
    )
  ) {
    throw new Error("Design screenshot data is not a WebP image.");
  }
}

/** Validate and normalize without publishing. Explicit exports use this before
 * their durable artifact side effect so a later cache update cannot turn an
 * otherwise-successful artifact write into a partial operation. */
export function normalizeDesignScreenshot(
  input: DesignScreenshot,
): DesignScreenshot {
  if (!input.workspaceId.trim()) throw new Error("workspaceId is required.");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.html$/i.test(input.frame)) {
    throw new Error(`Invalid design frame file: ${input.frame}`);
  }
  if (
    input.nodeId !== null &&
    (!input.nodeId.trim() || input.nodeId.length > 256)
  ) {
    throw new Error("nodeId must be null or a bounded non-empty string.");
  }
  if (!ALLOWED_MIME_TYPES.has(input.mimeType)) {
    throw new Error(`Unsupported design screenshot type: ${input.mimeType}`);
  }
  if (!/^[a-f0-9]{24}$/.test(input.sourceVersion)) {
    throw new Error("Design screenshot sourceVersion is invalid.");
  }
  if (
    !input.data ||
    input.data.length > MAX_BASE64_LENGTH ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(input.data)
  ) {
    throw new Error("Design screenshot data must be bounded base64.");
  }
  assertImageSignature(input.mimeType, input.data);
  const next: DesignScreenshot = {
    ...input,
    width: Math.round(finitePositive(input.width, "width")),
    height: Math.round(finitePositive(input.height, "height")),
    scale: finitePositive(input.scale, "scale"),
    capturedAt: finitePositive(input.capturedAt, "capturedAt"),
  };
  return next;
}

export function setDesignScreenshot(input: DesignScreenshot): void {
  const next = normalizeDesignScreenshot(input);
  const key = screenshotKey(next.workspaceId, next.frame, next.nodeId);
  screenshots.delete(key);
  screenshots.set(key, next);
  while (screenshots.size > MAX_SCREENSHOTS) {
    const oldest = screenshots.keys().next().value as string | undefined;
    if (!oldest) break;
    screenshots.delete(oldest);
  }
}

export function getDesignScreenshot(
  workspaceId: string,
  frame: string,
  nodeId: string | null,
  sourceVersion: string,
): DesignScreenshot | null {
  const key = screenshotKey(workspaceId, frame, nodeId);
  const screenshot = screenshots.get(key) ?? null;
  if (!screenshot) return null;
  if (screenshot.sourceVersion !== sourceVersion) return null;
  screenshots.delete(key);
  screenshots.set(key, screenshot);
  return screenshot;
}

export function forgetDesignScreenshots(workspaceId: string): void {
  const prefix = `${workspaceId}\u0000`;
  for (const key of screenshots.keys()) {
    if (key.startsWith(prefix)) screenshots.delete(key);
  }
}

export function resetDesignScreenshotsForTests(): void {
  screenshots.clear();
}
