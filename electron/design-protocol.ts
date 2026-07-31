import { net, protocol } from "electron";

import { currentLocalToken, ensureEngineRunning } from "./sidecar";

export const DESIGN_PROTOCOL_SCHEME = "zeros-design";

export interface ParsedDesignProtocolUrl {
  workspaceId: string;
  path: string;
  sourceVersion: string | null;
}

export function parseDesignProtocolUrl(
  value: string,
): ParsedDesignProtocolUrl | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (
    url.protocol !== `${DESIGN_PROTOCOL_SCHEME}:` ||
    url.hostname !== "workspace" ||
    url.username ||
    url.password ||
    url.port
  ) {
    return null;
  }
  let segments: string[];
  try {
    segments = url.pathname
      .split("/")
      .filter(Boolean)
      .map((segment) => decodeURIComponent(segment));
  } catch {
    return null;
  }
  const workspaceId = segments.shift() ?? "";
  if (
    !workspaceId ||
    workspaceId.length > 128 ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(workspaceId) ||
    segments.length === 0 ||
    segments.some(
      (segment) =>
        !segment ||
        segment === "." ||
        segment === ".." ||
        segment.includes("/") ||
        segment.includes("\\") ||
        segment.includes("\0"),
    )
  ) {
    return null;
  }
  const rawVersion = url.searchParams.get("v");
  if (rawVersion !== null && !/^[a-f0-9]{24}$/.test(rawVersion)) return null;
  return {
    workspaceId,
    path: segments.join("/"),
    sourceVersion: rawVersion,
  };
}

export function registerDesignProtocolPrivileges(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: DESIGN_PROTOCOL_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true,
        corsEnabled: false,
      },
    },
  ]);
}

export function installDesignProtocol(): void {
  protocol.handle(DESIGN_PROTOCOL_SCHEME, async (request) => {
    const parsed = parseDesignProtocolUrl(request.url);
    if (!parsed || request.method !== "GET") {
      return new Response("Not found.", {
        status: 404,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    }
    try {
      const port = await ensureEngineRunning();
      const encodedPath = parsed.path
        .split("/")
        .map((segment) => encodeURIComponent(segment))
        .join("/");
      const version = parsed.sourceVersion ? `?v=${parsed.sourceVersion}` : "";
      const target =
        `http://127.0.0.1:${port}/design/` +
        `${encodeURIComponent(parsed.workspaceId)}/${encodedPath}${version}`;
      return await net.fetch(target, {
        method: "GET",
        redirect: "error",
        headers: { "X-Zeros-Engine-Token": currentLocalToken() },
      });
    } catch {
      return new Response("Design renderer unavailable.", {
        status: 503,
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "no-store",
        },
      });
    }
  });
}
