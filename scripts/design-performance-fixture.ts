/** Generate a disposable, real Local checkout before native qualification.
 * Never modifies an existing directory, stages files, or changes a product
 * limit. `--frames N` uses the ordinary frame writer. Paged and replicated
 * fixtures (`--pages`, `--frames-per-page`, `--source`) clone source bytes
 * and write meta/canvas.json once through the engine's own encoder, then read
 * it back through the engine, so thousands of frames take seconds. */
import { execFileSync } from "node:child_process";
import { constants, existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { copyFile, cp, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  DESIGN_MAX_FRAMES_PER_PAGE,
  DESIGN_MAX_PAGES,
} from "../packages/protocol/src/design-pages";
import { initializeDesignDocument, createDesignFrame } from "../apps/desktop/src/engine/design/document";
import { designDirectoryNameFor } from "../apps/desktop/src/engine/design/directory-registry";
import { decodeCanvasFile, encodeCanvasFile } from "../apps/desktop/src/engine/design/canvas-file";
import { readCanvas } from "../apps/desktop/src/engine/design/document-storage";

const PERFORMANCE_CSS = `
*{box-sizing:border-box}body{margin:0;font:16px system-ui;background:#fafafa;color:#222}
main{padding:24px}.cards{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}
.card{display:flex;flex-direction:column;gap:8px;padding:12px;border:1px solid #ddd;border-radius:12px;background:linear-gradient(135deg,#fff,#e9f1ff)}
h1{font-size:24px;margin:0 0 20px}h2,p{margin:0}h2{font-size:14px}p{font-size:12px;line-height:1.5}
.effect{filter:drop-shadow(0 2px 4px #0003)}svg{width:100%;height:32px}img{width:24px;height:24px}
`;
// Authored 24px RGBA circle. External SVG references are intentionally not
// supported; use an actual supported image so native runs include decoding.
const PERFORMANCE_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAABgAAAAYCAYAAADgdz34AAAAVUlEQVR4nGMIqn/KQEtMU8NJseA/DkyxBbgMJtoiSg0maBE1DcdqCd0toNRwDEvoagG1DEexZNSCEWbB0M8Hw6MsoktxTZcKh1iLCOol1gKyMc0tAABSihSQfE70tAAAAABJRU5ErkJggg==", "base64");
const TEXT_SEED = "Native transparent text — crisp type, no opaque artboard";
/** Clone on APFS/Btrfs/XFS; an ordinary copy where the filesystem cannot. */
const CLONE = constants.COPYFILE_FICLONE;

function performanceHtml(title: string, prefix: string, complex: boolean): string {
  const cards = Array.from({ length: complex ? 48 : 3 }, (_, card) => `
    <article class="card" data-oid="card-${card}"><h2 data-oid="heading-${card}">Item ${card + 1}</h2>
    <p data-oid="copy-${card}">Text, layout and image detail for the same reproducible viewport.</p>
    <img data-oid="image-${card}" src="${prefix}performance.png" alt=""/>
    ${complex ? `<svg class="effect" data-oid="vector-${card}" viewBox="0 0 100 32"><path d="M0 28 Q25 0 50 16 T100 4" stroke="#527fe5" stroke-width="2" fill="none"/></svg>` : ""}</article>`).join("");
  return `<!doctype html><html><head><link rel="stylesheet" href="${prefix}performance.css"></head><body><main data-oid="scene" data-zeros-frame-root><h1 data-oid="title">${title}</h1><div class="cards" data-oid="cards">${cards}</div></main></body></html>`;
}

function integer(value: string | undefined, name: string, min: number, max: number, fallback?: number): number {
  if (value === undefined && fallback !== undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw new Error(`Use ${name} between ${min} and ${max}.`);
  return parsed;
}

interface SourceFrame { file: string; title: string; width: number; height: number; kind: "frame" | "text" }
interface SourcePage { folder: string; frames: SourceFrame[]; files: string[] }

/** Frames grouped by source page, plus each page folder's non-HTML files
 * (page stylesheets) that its frames link by a relative name. */
function readSourcePages(designRoot: string, only?: readonly string[]): { pages: SourcePage[]; document: Record<string, unknown> } {
  const canvasText = readFileSync(path.join(designRoot, "meta/canvas.json"), "utf8");
  const document = decodeCanvasFile(canvasText, { version: 2 }) as Record<string, unknown> & {
    pages: { folder: string; frames: string[] }[];
    frames: Record<string, { w: number; h: number }>;
    frame_info: Record<string, { id: string; title: string; kind: "frame" | "text" }>;
  };
  const fileById = new Map(Object.entries(document.frame_info).map(([file, info]) => [info.id, file]));
  const pages = document.pages.map((page) => ({
    folder: page.folder,
    frames: page.frames.flatMap((id) => {
      const file = fileById.get(id);
      if (!file || !existsSync(path.join(designRoot, file))) return [];
      const geometry = document.frames[file]!, info = document.frame_info[file]!;
      return [{ file, title: info.title, width: geometry.w, height: geometry.h, kind: info.kind }];
    }),
    files: existsSync(path.join(designRoot, page.folder))
      ? readdirSync(path.join(designRoot, page.folder), { withFileTypes: true })
        .filter((entry) => entry.isFile() && !/\.html$/i.test(entry.name)).map((entry) => entry.name)
      : [],
  })).filter((page) => page.frames.length > 0 && (!only || only.includes(page.folder)));
  if (!pages.length) throw new Error("The source Design directory has no registered frames to replicate.");
  if (only?.some((folder) => !pages.some((page) => page.folder === folder)))
    throw new Error("Every --source-pages folder must be a source page with frames.");
  return { pages, document };
}

/** Style sources resolve inside the repository: copy each declared file and
 * every relative stylesheet it imports, and whole packages for bare imports.
 * The engine bundles Tailwind itself and never scans `@source` folders. */
async function copyStyleClosure(sourceRoot: string, outputRoot: string, entries: string[]): Promise<number> {
  const seen = new Set<string>();
  const pending = [...entries];
  let copied = 0;
  const inside = (file: string) => !path.relative(sourceRoot, file).startsWith("..");
  while (pending.length) {
    const relative = pending.pop()!;
    if (seen.has(relative)) continue;
    seen.add(relative);
    const from = path.join(sourceRoot, relative);
    if (!inside(from) || !existsSync(from)) continue;
    const to = path.join(outputRoot, relative);
    await mkdir(path.dirname(to), { recursive: true });
    if (statSync(from).isDirectory()) {
      // pnpm links packages into its store; copy their files, not the link.
      await cp(from, to, { recursive: true, dereference: true, mode: CLONE, errorOnExist: false, force: false });
      copied++;
      continue;
    }
    await copyFile(from, to, CLONE);
    copied++;
    if (!/\.(?:css|scss|sass)$/i.test(relative)) continue;
    const text = readFileSync(from, "utf8");
    for (const match of text.matchAll(/@import\s+(?:url\()?\s*["']([^"']+)["']|url\(\s*["']?([^"')]+)["']?\s*\)/g)) {
      const specifier = (match[1] ?? match[2] ?? "").split(/[?#]/)[0]!;
      if (!specifier || /^(?:[a-z]+:|\/\/|#)/i.test(specifier) || specifier === "tailwindcss" || specifier.startsWith("tailwindcss/")) continue;
      if (specifier.startsWith(".")) {
        pending.push(path.relative(sourceRoot, path.resolve(path.dirname(from), specifier)));
        continue;
      }
      const name = specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0]!;
      for (let directory = path.dirname(from); inside(directory); directory = path.dirname(directory)) {
        const candidate = path.join(directory, "node_modules", name);
        if (existsSync(candidate)) {
          pending.push(path.relative(sourceRoot, candidate));
          break;
        }
        if (directory === sourceRoot) break;
      }
    }
  }
  return copied;
}

async function main() {
  const args = process.argv.slice(2);
  const argument = (name: string) => {
    const index = args.indexOf(name);
    const value = index < 0 ? undefined : args[index + 1];
    if (index >= 0 && (!value || value.startsWith("--"))) throw new Error(`${name} requires a value.`);
    return value;
  };
  const complex = args.includes("--complex");
  const mixed = args.includes("--mixed");
  const layout = argument("--layout") ?? "grid";
  if (layout !== "grid" && layout !== "fixed-view") throw new Error("Use --layout grid or fixed-view.");
  const source = argument("--source");
  const paged = source !== undefined || args.includes("--pages") || args.includes("--frames-per-page");
  if (paged && args.includes("--frames")) throw new Error("Use --frames for a one-page fixture, or --pages with --frames-per-page.");
  if (!paged) {
    const count = Number(argument("--frames") ?? "32");
    if (![2, 32, 128, 256].includes(count)) throw new Error("Use --frames 2, 32, 128 or 256.");
    const output = path.resolve(argument("--output") ?? `.context/design-performance-fixture-${count}`);
    // mkdir without recursive refuses an existing checkout, including a symlink.
    await mkdir(output);
    execFileSync("git", ["init", "-q"], { cwd: output });
    await initializeDesignDocument(output);
    const directory = designDirectoryNameFor(output);
    const root = path.join(output, directory);
    await writeFile(path.join(root, "performance.css"), PERFORMANCE_CSS);
    await writeFile(path.join(root, "performance.png"), PERFORMANCE_PNG);
    const files: string[] = [];
    for (let index = 0; index < count; index++) {
      const distant = layout === "fixed-view" && index >= 2;
      const frame = await createDesignFrame(output, { title: `Performance ${index + 1}`,
        ...(mixed && index % 2 ? { seed: { kind: "text" as const, nodeId: "native-text", text: TEXT_SEED, fixedSize: true } } : {}),
        geometry: { x: (distant ? 20_000 : 0) + (index % 16) * 640,
          y: (distant ? 20_000 : 0) + Math.floor(index / 16) * 440, w: 560, h: 360, z: index } });
      files.push(frame.file);
    }
    for (const [index, file] of files.entries()) {
      if (mixed && index % 2) continue; // Keep the ordinary transparent text seed.
      const prefix = file.includes("/") ? "../" : "";
      await writeFile(path.join(root, file), performanceHtml(`Performance ${index + 1}`, prefix, complex));
    }
    console.log(JSON.stringify({ workspace: output, designDirectory: directory, frames: count, layout, mixed,
      complexity: complex ? "48 cards per frame, flex/grid, SVG, local images and effects" : "3 cards per frame",
      fonts: "system font", next: "Open this checkout as a Local workspace in the exact Electron build. Record fixed-view, overview, editing/capture, hidden, and owner-switch scenarios separately." }, null, 2));
    return;
  }

  const pageCount = integer(argument("--pages"), "--pages", 1, DESIGN_MAX_PAGES, 1);
  const perPage = integer(argument("--frames-per-page"), "--frames-per-page", 1, DESIGN_MAX_FRAMES_PER_PAGE, DESIGN_MAX_FRAMES_PER_PAGE);
  const styles = argument("--styles") ?? "copy";
  if (styles !== "copy" && styles !== "none") throw new Error("Use --styles copy or none.");
  if (source !== undefined && (complex || mixed)) throw new Error("--complex and --mixed shape synthetic frames; a replica keeps its source frames.");
  const output = path.resolve(argument("--output") ?? `.context/design-performance-fixture-${pageCount}x${perPage}`);
  const started = Date.now();
  const sourceRoot = source === undefined ? undefined : path.resolve(source);
  if (sourceRoot && !existsSync(path.join(sourceRoot, "meta/canvas.json")))
    throw new Error("--source must be a paged Design directory with meta/canvas.json.");
  const replica = sourceRoot ? readSourcePages(sourceRoot, argument("--source-pages")?.split(",")) : undefined;
  // Every page cycles through all source frames, so each page folder needs
  // the union of the source pages' stylesheets; a name clash would rebind one.
  const sourceFrames = replica?.pages.flatMap((page) => page.frames) ?? [];
  const pageFiles = new Map<string, string>();
  for (const page of replica?.pages ?? [])
    for (const file of page.files) {
      const from = path.join(sourceRoot!, page.folder, file);
      const existing = pageFiles.get(file);
      if (existing && !readFileSync(existing).equals(readFileSync(from)))
        throw new Error(`Source pages both define ${file}; choose pages with --source-pages.`);
      pageFiles.set(file, from);
    }
  const repositoryRoot = sourceRoot
    ? execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: sourceRoot, encoding: "utf8" }).trim()
    : undefined;
  await mkdir(output);
  execFileSync("git", ["init", "-q"], { cwd: output });
  await initializeDesignDocument(output);
  const directory = designDirectoryNameFor(output);
  const root = path.join(output, directory);
  const canvasFile = path.join(root, "meta/canvas.json");
  const initial = decodeCanvasFile(await readFile(canvasFile, "utf8"), { version: 2 });
  if (sourceRoot) {
    for (const shared of ["tokens.css", "assets", "components"]) {
      const from = path.join(sourceRoot, shared);
      if (!existsSync(from)) continue;
      await cp(from, path.join(root, shared), { recursive: true, mode: CLONE, force: true });
    }
  } else {
    await writeFile(path.join(root, "performance.css"), PERFORMANCE_CSS);
    await writeFile(path.join(root, "performance.png"), PERFORMANCE_PNG);
  }
  const hex = (value: number) => value.toString(16).padStart(32, "0");
  const pages: { id: string; title: string; folder: string; frames: string[] }[] = [];
  const frames: Record<string, { x: number; y: number; w: number; h: number; z: number }> = {};
  const frameInfo: Record<string, { id: string; title: string; kind: "frame" | "text" }> = {};
  let bytes = 0;
  for (let page = 0; page < pageCount; page++) {
    const folder = `page-${page + 1}`;
    await mkdir(path.join(root, folder), { recursive: true });
    for (const [file, from] of pageFiles) await copyFile(from, path.join(root, folder, file), CLONE);
    const columns = Math.ceil(Math.sqrt(perPage));
    const cellWidth = (sourceFrames.length ? Math.max(...sourceFrames.map((frame) => frame.width)) : 560) + 160;
    const cellHeight = (sourceFrames.length ? Math.max(...sourceFrames.map((frame) => frame.height)) : 360) + 160;
    const record = { id: `page_${hex(page)}`, title: `Page ${page + 1}`, folder, frames: [] as string[] };
    for (let index = 0; index < perPage; index++) {
      const original = sourceFrames.length ? sourceFrames[(page * perPage + index) % sourceFrames.length] : undefined;
      const stem = original ? path.posix.basename(original.file, ".html") : "performance";
      const file = `${folder}/${stem}-${index + 1}.html`;
      const target = path.join(root, file);
      if (original) await copyFile(path.join(sourceRoot!, original.file), target, CLONE);
      else {
        const text = mixed && index % 2;
        await writeFile(target, text
          ? `<!doctype html><html><head><link rel="stylesheet" href="../tokens.css"></head><body style="background:transparent !important"><p data-oid="native-text">${TEXT_SEED}</p></body></html>`
          : performanceHtml(`Performance ${page + 1}.${index + 1}`, "../", complex));
      }
      bytes += statSync(target).size;
      const distant = layout === "fixed-view" && index >= 2;
      const id = `frame_${hex(page * 1_000_000 + index)}`;
      record.frames.push(id);
      frames[file] = {
        x: (distant ? 20_000 : 0) + (index % columns) * cellWidth,
        y: (distant ? 20_000 : 0) + Math.floor(index / columns) * cellHeight,
        w: original?.width ?? 560,
        h: original?.height ?? 360,
        z: index,
      };
      frameInfo[file] = {
        id,
        title: `${original?.title ?? "Performance"} ${page + 1}.${index + 1}`.slice(0, 120),
        kind: original?.kind ?? (mixed && index % 2 ? "text" : "frame"),
      };
    }
    pages.push(record);
  }
  const copiedStyles = replica && styles === "copy" && repositoryRoot
    ? await copyStyleClosure(repositoryRoot, output,
      ((replica.document.styles as { path?: unknown }[] | undefined) ?? []).flatMap((entry) => typeof entry.path === "string" ? [entry.path] : []))
    : 0;
  const { styles: sourceStyles, themes, foundation } = replica?.document ?? {};
  const canvas = encodeCanvasFile({
    ...initial,
    ...(foundation ? { foundation } : {}),
    ...(themes ? { themes } : {}),
    ...(styles === "copy" && sourceStyles ? { styles: sourceStyles } : {}),
    version: 3,
    pages,
    frames,
    frame_info: frameInfo,
  }, { version: 2 });
  await writeFile(canvasFile, canvas);
  const confirmed = await readCanvas(output);
  if (Object.keys(confirmed.frames).length !== pageCount * perPage) throw new Error("The engine did not read back every generated frame.");
  console.log(JSON.stringify({ workspace: output, designDirectory: directory, pages: pageCount, framesPerPage: perPage,
    frames: pageCount * perPage, layout, ...(sourceRoot ? { source: sourceRoot, sourcePages: replica!.pages.map((page) => page.folder), styles, copiedStyleEntries: copiedStyles } : { mixed, complexity: complex ? "48 cards per frame" : "3 cards per frame" }),
    frameBytes: bytes, canvasBytes: Buffer.byteLength(canvas), seconds: Math.round((Date.now() - started) / 100) / 10,
    next: "Open this checkout as a Local workspace in the exact Electron build. Each frame file is a clone where the filesystem supports it." }, null, 2));
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
