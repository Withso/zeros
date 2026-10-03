import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DESIGN_CAPTURE_PNG_BYTES, DESIGN_CAPTURE_TIMEOUT_MS, designCaptureRasterSize } from "@zeros/protocol/design-capture";
import { designContextReferenceSchema } from "@zeros/protocol/design-context";
import { assertDesignCapturePng } from "./capture-service";

/** Ordinary shell entrypoint; no MCP discovery, browser session or privileged
 * filesystem write is needed. The provider's existing shell policy applies. */
export async function runDesignVerificationCli(args: string[], output: (line: string) => void = console.log): Promise<number> {
  const [operation] = args;
  const flag = (name: string) => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
  if (operation === "--help" || operation === "-h") {
    output("design <list|validate|capture|preview> --url <workspace verification URL> [--frame screen.html] [--revision <source revision>] [--output .context/frame.png]");
    return 0;
  }
  if (!["list", "validate", "capture", "preview"].includes(operation ?? "")) throw new Error("Choose design list, validate, capture or preview. Use design --help for options.");
  const url = new URL(flag("--url") ?? "");
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.username || url.password || url.search || url.hash || !/^\/[a-f0-9]{48}$/.test(url.pathname))
    throw new Error("Use the local Design verification URL supplied by Zeros.");
  const frame = flag("--frame");
  if (operation !== "list" && (!frame || !/^[A-Za-z0-9][A-Za-z0-9._-]*\.html$/i.test(frame))) throw new Error("--frame must name a registered HTML frame.");
  const base = operation === "list" ? `${url}/frames` : `${url}/${encodeURIComponent(frame!)}`;
  const request = async (target: string) => {
    const response = await fetch(target, { redirect: "error", signal: AbortSignal.timeout(DESIGN_CAPTURE_TIMEOUT_MS + 3000) });
    if (!response.ok) {
      const message = await response.json().catch(() => null) as { error?: string } | null;
      throw new Error(message?.error ?? `Design verification failed (${response.status}).`);
    }
    return response;
  };
  if (operation === "list") { output(JSON.stringify(await (await request(base)).json())); return 0; }
  const expected = flag("--revision");
  const state = await (await request(`${base}/state${expected ? `?revision=${encodeURIComponent(expected)}` : ""}`)).json() as { reference: unknown; width: number; height: number };
  const reference = designContextReferenceSchema.parse(state.reference);
  const query = `?revision=${reference.revision}&frameId=${encodeURIComponent(reference.frameId ?? "")}`;
  if (operation === "preview") {
    output(JSON.stringify({ ...state, url: `${base}/?frameId=${encodeURIComponent(reference.frameId ?? "")}`, refresh: "live while visible", expires: "30 minutes after last context/preview request" }));
    return 0;
  }
  if (operation === "validate") {
    const result = await (await request(`${base}/validate${query}`)).json() as { report?: { violations?: { severity?: string }[] } };
    output(JSON.stringify(result));
    return result.report?.violations?.some((issue) => issue.severity === "error") ? 1 : 0;
  }
  const filename = flag("--output");
  if (!filename) throw new Error("capture requires --output, for example .context/frame.png.");
  const response = await request(`${base}/capture${query}`);
  if (response.headers.get("x-design-revision") !== reference.revision) throw new Error("Capture returned a different revision.");
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Capture returned no PNG.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const item = await reader.read(); if (item.done) break;
      size += item.value.byteLength;
      if (size > DESIGN_CAPTURE_PNG_BYTES) throw new Error("Capture exceeds the PNG byte budget.");
      chunks.push(item.value);
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  const bytes = Buffer.concat(chunks);
  const viewport = { width: Math.ceil(state.width), height: Math.ceil(state.height) };
  const raster = designCaptureRasterSize(viewport);
  assertDesignCapturePng(bytes, raster.width, raster.height);
  const destination = path.resolve(filename);
  await mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, bytes, { flag: "wx" }); await rename(temporary, destination); }
  finally { await rm(temporary, { force: true }); }
  output(JSON.stringify({ ...state, width: raster.width, height: raster.height, viewport, scale: raster.scale, path: destination, capturedAt: Number(response.headers.get("x-design-captured-at")), motion: "reduced", visualInspection: "Open this PNG with your ordinary image tool. Capturing alone is not visual inspection." }));
  return 0;
}
