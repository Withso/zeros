import { createHmac, timingSafeEqual } from "node:crypto";

const CAPABILITY_PATTERN = /^[a-f0-9]{64}$/;
const WORKSPACE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function createDesignProtocolCapability(
  launchSecret: string,
  workspaceId: string,
): string {
  return createHmac("sha256", launchSecret)
    .update("zeros-design-resource\0", "utf8")
    .update(workspaceId, "utf8")
    .digest("hex");
}

export function validateDesignProtocolCapability(
  launchSecret: string,
  workspaceId: string,
  capability: string,
): boolean {
  if (!CAPABILITY_PATTERN.test(capability)) return false;
  const expected = Buffer.from(
    createDesignProtocolCapability(launchSecret, workspaceId),
    "hex",
  );
  const supplied = Buffer.from(capability, "hex");
  return (
    supplied.length === expected.length && timingSafeEqual(supplied, expected)
  );
}

export function parseDesignProtocolResourcePath(
  pathname: string,
  launchSecret: string,
): { workspaceId: string; resourcePath: string } | null {
  const match = /^\/design\/([^/]+)\/([a-f0-9]{64})\/(.+)$/.exec(pathname);
  if (!match) return null;
  let workspaceId: string;
  let segments: string[];
  try {
    workspaceId = decodeURIComponent(match[1]!);
    segments = match[3]!
      .split("/")
      .map((segment) => decodeURIComponent(segment));
  } catch {
    return null;
  }
  if (
    !WORKSPACE_ID_PATTERN.test(workspaceId) ||
    segments.length === 0 ||
    segments.some(
      (segment) =>
        !segment ||
        segment === "." ||
        segment === ".." ||
        segment.includes("/") ||
        segment.includes("\\") ||
        segment.includes("\0"),
    ) ||
    !validateDesignProtocolCapability(launchSecret, workspaceId, match[2]!)
  ) {
    return null;
  }
  return { workspaceId, resourcePath: segments.join("/") };
}
