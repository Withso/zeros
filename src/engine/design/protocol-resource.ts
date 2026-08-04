import path from "node:path";

import postcss from "postcss";

import {
  DESIGN_DIRECTORY_NAME,
  insertDesignRuntimeScript,
  readDesignFrameRenderSourceFromSource,
} from "./document";
import { readSafeRegularFile } from "./safe-files";

const MAX_TEXT_RESOURCE_BYTES = 2 * 1024 * 1024;
const MAX_BINARY_RESOURCE_BYTES = 10 * 1024 * 1024;

const MIME_TYPES = Object.freeze<Record<string, string>>({
  ".avif": "image/avif",
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
});

export interface DesignProtocolResource {
  status: number;
  mimeType: string;
  headers: Record<string, string>;
  body: Buffer;
}

interface DesignProtocolResourceInput {
  path: string;
  sourceVersion: string | null;
}

function response(
  status: number,
  body: string | Buffer,
  mimeType = "text/plain; charset=utf-8",
  headers: Record<string, string> = {},
): DesignProtocolResource {
  return {
    status,
    mimeType,
    headers: {
      "Content-Type": mimeType,
      "X-Content-Type-Options": "nosniff",
      // The iframe deliberately has an opaque sandbox origin. Its relative
      // CSS/images therefore need an explicit cross-origin resource policy;
      // CORP does not grant CORS read access, and this route remains limited
      // to the authenticated custom-protocol proxy.
      "Cross-Origin-Resource-Policy": "cross-origin",
      ...headers,
    },
    body: Buffer.isBuffer(body) ? body : Buffer.from(body, "utf8"),
  };
}

function cacheHeaders(sourceVersion: string | null): Record<string, string> {
  return {
    "Cache-Control": sourceVersion
      ? "private, max-age=31536000, immutable"
      : "private, no-store",
  };
}

function safeRelativePath(value: string): string | null {
  if (
    !value ||
    value.length > 512 ||
    value.includes("\0") ||
    value.includes("\\") ||
    value.startsWith("/")
  ) {
    return null;
  }
  const segments = value.split("/");
  if (
    segments.some((segment) => !segment || segment === "." || segment === "..")
  ) {
    return null;
  }
  return segments.join("/");
}

function versionRelativeReference(
  value: string,
  sourceVersion: string,
): string {
  const trimmed = value.trim();
  if (
    !trimmed ||
    trimmed.startsWith("#") ||
    trimmed.startsWith("/") ||
    trimmed.startsWith("//") ||
    /^[a-z][a-z0-9+.-]*:/i.test(trimmed)
  ) {
    return value;
  }
  const hashIndex = trimmed.indexOf("#");
  const hash = hashIndex >= 0 ? trimmed.slice(hashIndex) : "";
  const withoutHash = hashIndex >= 0 ? trimmed.slice(0, hashIndex) : trimmed;
  const queryIndex = withoutHash.indexOf("?");
  const pathname =
    queryIndex >= 0 ? withoutHash.slice(0, queryIndex) : withoutHash;
  const params = new URLSearchParams(
    queryIndex >= 0 ? withoutHash.slice(queryIndex + 1) : "",
  );
  params.set("v", sourceVersion);
  return `${pathname}?${params.toString()}${hash}`;
}

function versionCssResources(source: string, sourceVersion: string): string {
  let root: postcss.Root;
  try {
    root = postcss.parse(source);
  } catch {
    return source;
  }
  const rewriteUrls = (value: string) =>
    value.replace(
      /url\(\s*(["']?)([^"')]+)\1\s*\)/gi,
      (_match, quote: string, reference: string) =>
        `url(${quote}${versionRelativeReference(reference, sourceVersion)}${quote})`,
    );
  root.walkDecls((declaration) => {
    declaration.value = rewriteUrls(declaration.value);
  });
  root.walkAtRules("import", (rule) => {
    rule.params = rewriteUrls(rule.params).replace(
      /^\s*(["'])([^"']+)\1/,
      (_match, quote: string, reference: string) =>
        `${quote}${versionRelativeReference(reference, sourceVersion)}${quote}`,
    );
  });
  return root.toString();
}

function injectRuntime(
  source: string,
  sourceVersion: string,
): { html: string; csp: string } {
  const injected = insertDesignRuntimeScript(source, sourceVersion);
  const csp =
    `default-src 'none'; script-src ${injected.cspSource}; ` +
    `style-src zeros-design: 'unsafe-inline'; img-src zeros-design: data: blob:; ` +
    `font-src zeros-design: data:; media-src zeros-design: data:; connect-src 'none'; ` +
    `worker-src 'none'; frame-src 'none'; object-src 'none'; ` +
    `base-uri 'none'; form-action 'none'; sandbox allow-scripts`;
  return { html: injected.html, csp };
}

export async function readDesignProtocolResource(
  workspacePath: string,
  input: DesignProtocolResourceInput,
): Promise<DesignProtocolResource> {
  const relativePath = safeRelativePath(input.path);
  if (!relativePath) return response(404, "Not found.");
  const sourceVersion =
    input.sourceVersion && /^[a-f0-9]{24}$/.test(input.sourceVersion)
      ? input.sourceVersion
      : null;
  const extension = path.extname(relativePath).toLowerCase();
  const topLevelHtml =
    extension === ".html" && !relativePath.includes("/") ? relativePath : null;
  const allowedResource =
    (extension === ".css" && !relativePath.includes("/")) ||
    (relativePath.startsWith("assets/") && MIME_TYPES[extension]);
  if (!topLevelHtml && !allowedResource) return response(404, "Not found.");
  const byteLimit =
    topLevelHtml || extension === ".css"
      ? MAX_TEXT_RESOURCE_BYTES
      : MAX_BINARY_RESOURCE_BYTES;
  const designRoot = path.join(workspacePath, DESIGN_DIRECTORY_NAME);
  const safe = await readSafeRegularFile(
    designRoot,
    path.join(designRoot, ...relativePath.split("/")),
    byteLimit + 1,
  );
  if (!safe) return response(404, "Not found.");
  if (safe.size > byteLimit) return response(413, "Resource is too large.");

  if (topLevelHtml) {
    const authored = safe.body.toString("utf8");
    const renderSource = await readDesignFrameRenderSourceFromSource(
      workspacePath,
      topLevelHtml,
      authored,
    ).catch(() => null);
    if (!renderSource) return response(404, "Not found.");
    if (sourceVersion && sourceVersion !== renderSource.sourceVersion) {
      return response(409, "Design frame generation changed.", undefined, {
        "Cache-Control": "private, no-store",
      });
    }
    const rendered = injectRuntime(
      renderSource.html,
      renderSource.sourceVersion,
    );
    return response(200, rendered.html, "text/html; charset=utf-8", {
      ...cacheHeaders(sourceVersion),
      "Content-Security-Policy": rendered.csp,
    });
  }

  const rawBody = safe.body;
  const body =
    extension === ".css" && sourceVersion
      ? Buffer.from(
          versionCssResources(rawBody.toString("utf8"), sourceVersion),
          "utf8",
        )
      : rawBody;
  return response(200, body, MIME_TYPES[extension]!, {
    ...cacheHeaders(sourceVersion),
    "Content-Security-Policy": "default-src 'none'; sandbox",
  });
}
