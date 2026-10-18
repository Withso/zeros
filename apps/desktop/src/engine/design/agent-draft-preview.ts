import { parse } from "parse5";
import { MAX_DESIGN_AGENT_DRAFT_PREVIEW_BYTES } from "@zeros/protocol/design-agent-drafts";
import { readBoundedDesignFrameSource, readCanvas } from "./document-storage";
import { readFrameMeta } from "./frame-metadata";
import { prepareFrameRenderSource } from "./render-preparation";
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

/** The saved frame an in-flight Edit applies to. Call inside the lease. */
export async function readDesignAgentDraftBase(
  workspacePath: string,
  file: string,
): Promise<string | null> {
  return readBoundedDesignFrameSource(workspacePath, file).catch(() => null);
}
