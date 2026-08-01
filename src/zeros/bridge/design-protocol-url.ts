const CAPABILITY_PATTERN = /^[a-f0-9]{64}$/;
const SOURCE_VERSION_PATTERN = /^[a-f0-9]{24}$/;
const WORKSPACE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** Build the local custom-protocol frame route only when both authorities are
 * exact. A null result deliberately falls back to the already-sanitized srcDoc. */
export function designProtocolFrameUrl(input: {
  workspaceId: string;
  capability: string | null;
  frame: string;
  sourceVersion: string;
}): string | null {
  if (
    !WORKSPACE_ID_PATTERN.test(input.workspaceId) ||
    !input.frame ||
    input.frame === "." ||
    input.frame === ".." ||
    /[\\/\0]/.test(input.frame) ||
    !input.capability ||
    !CAPABILITY_PATTERN.test(input.capability) ||
    !SOURCE_VERSION_PATTERN.test(input.sourceVersion)
  ) {
    return null;
  }
  return (
    `zeros-design://workspace/${encodeURIComponent(input.workspaceId)}/` +
    `${input.capability}/${encodeURIComponent(input.frame)}?v=${input.sourceVersion}`
  );
}
