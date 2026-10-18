import path from "node:path";
import { parse } from "parse5";
import {
  MAX_DESIGN_AGENT_DRAFT_PREVIEW_BYTES,
  MAX_DESIGN_AGENT_DRAFT_STYLESHEET_CHARS,
} from "@zeros/protocol/design-agent-drafts";
import { isDesignFrameFile } from "@zeros/protocol/design-path";
import {
  designDirectory,
  readBoundedDesignFrameSource,
  readCanvas,
} from "./document-storage";
import { MAX_DESIGN_TEXT_BYTES } from "./render-budget";
import { readSafeRegularFile } from "./safe-files";
import { readFrameMeta } from "./frame-metadata";
import {
  prepareDesignStylesheetPreview,
  prepareFrameRenderSource,
} from "./render-preparation";
import { insertDesignHeadMarkup } from "./source";

/** A draft document runs no script at all: no Zeros runtime, no authored code.
 * The desktop also loads it in a fully sandboxed (scriptless) iframe. */
const DRAFT_POLICY =
  `<meta http-equiv="Content-Security-Policy" ` +
  `content="default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; ` +
  `img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; ` +
  `worker-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; ` +
  `form-action 'none';">`;

/** Render a frame's in-flight HTML exactly as its saved form would render
 * (local stylesheets, imported style sources, components, inlined assets and
 * the same sanitizer), minus the runtime. Call inside the directory lease. */
export async function composeDesignAgentDraftPreview(
  workspacePath: string,
  file: string,
  html: string,
): Promise<{ srcDoc: string; width: number; height: number; title: string } | null> {
  const canvas = await readCanvas(workspacePath).catch(() => undefined);
  const meta = readFrameMeta(parse(html), file, canvas);
  const viewport = { width: meta.width, height: meta.height };
  const { sanitized } = await prepareFrameRenderSource(
    workspacePath,
    html,
    viewport,
    undefined,
    undefined,
    file,
    canvas,
  );
  const srcDoc = insertDesignHeadMarkup(sanitized, DRAFT_POLICY);
  if (Buffer.byteLength(srcDoc, "utf8") > MAX_DESIGN_AGENT_DRAFT_PREVIEW_BYTES)
    return null;
  return { srcDoc, ...viewport, title: meta.title };
}

/** In-flight stylesheet text as live frames render it: rebased for a page
 * folder's frames (every page folder sits one level deep) and with local
 * assets inlined. Null when it is unrenderable or over the draft bound. Call
 * inside the lease. */
export async function composeDesignAgentStylesheetPreview(
  workspacePath: string,
  file: string,
  css: string,
): Promise<string | null> {
  const canvas = await readCanvas(workspacePath).catch(() => undefined);
  const folder = canvas?.pages?.find((page) => page.folder)?.folder;
  const entry = folder ? `${folder}/zeros-draft.html` : "zeros-draft.html";
  const processed = await prepareDesignStylesheetPreview(workspacePath, file, css, entry);
  if (processed === null || processed.length > MAX_DESIGN_AGENT_DRAFT_STYLESHEET_CHARS)
    return null;
  return processed;
}

/** The saved Design text file an in-flight Edit applies to: a frame, a
 * stylesheet or the canvas document, bounded like frame sources. Call inside
 * the lease. */
export async function readDesignAgentDraftBase(
  workspacePath: string,
  file: string,
): Promise<string | null> {
  // isDesignFrameFile narrows its argument; keep the declared path type.
  const relative: string = file;
  if (isDesignFrameFile(file))
    return readBoundedDesignFrameSource(workspacePath, file).catch(() => null);
  const parts = relative.split("/");
  if (!/\.(?:css|json)$/i.test(relative) || parts.some((part) => !part || part === "." || part === ".."))
    return null;
  const directory = designDirectory(workspacePath);
  const safe = await readSafeRegularFile(
    directory,
    path.join(directory, ...parts),
    MAX_DESIGN_TEXT_BYTES,
  ).catch(() => null);
  return safe ? safe.body.toString("utf8") : null;
}
