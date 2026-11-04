import { createHash } from "node:crypto";
import path from "node:path";
import { parse, type DefaultTreeAdapterTypes } from "parse5";
import { readSafeDesignText, safeLocalReference } from "./assets";
import { designDirectory, readCanvas, type DesignCanvasReadContext } from "./document-storage";
import { MAX_STYLESHEETS_PER_FRAME } from "./render-budget";
import { elementRecords } from "./source";
import { designStyleCache, designStyleCacheKey } from "./style-cache";
import { designCatalogHasClass, extractDesignClassCatalog, type DesignClassCatalog } from "./style-class-selectors";
import {
  designFrameClassFonts,
  designTailwindClassSource,
  frameStyleSourceIds,
  MAX_DESIGN_TAILWIND_FRAME_CSS_BYTES,
  readDesignStyleSourceCatalog,
  readDesignStyleSources,
} from "./style-sources";
import { designTailwindCandidates, designTailwindVariables, MAX_TAILWIND_CANDIDATES } from "./style-tailwind";

/** Tailwind relationship markers emit no utilities of their own; Lucide
 * supplies icon marker classes while styling its SVGs through attributes. */
export const DESIGN_CLASS_MARKERS = /^(?:(?:group|peer)(?:\/[^\t\n\f\r ]+)?|lucide(?:-[^\t\n\f\r ]+)?)$/;

export type DesignKnownClasses = (
  file: string,
  expandedHtml: string,
  document?: DefaultTreeAdapterTypes.Document,
) => Promise<{ has(name: string): boolean } | null>;

type TailwindSource = NonNullable<Awaited<ReturnType<typeof designTailwindClassSource>>>;
interface ImportedClasses {
  catalog: DesignClassCatalog;
  tailwind?: TailwindSource;
}

const EMPTY_CLASSES: DesignClassCatalog = { names: new Set(), attributes: [], bytes: 128 };

function cssClasses(root: string, css: string, revision?: string): DesignClassCatalog | null {
  const key = designStyleCacheKey(root, "class-catalog", revision ?? createHash("sha256").update(css).digest("hex"));
  const cached = designStyleCache.get<DesignClassCatalog | null>(key);
  if (cached !== undefined) return cached;
  let catalog: DesignClassCatalog | null;
  try { catalog = extractDesignClassCatalog(css); }
  catch { catalog = null; }
  designStyleCache.set(key, catalog, (catalog?.bytes ?? 64) + key.length * 2);
  return catalog;
}

async function candidateClasses(root: string, source: TailwindSource, candidates: string[]): Promise<(DesignClassCatalog | null)[]> {
  const keys = candidates.map((candidate) => designStyleCacheKey(root, "class-candidate", `${source.revision}\0${candidate}`));
  const cached = keys.map((key) => designStyleCache.get<Promise<DesignClassCatalog | null>>(key));
  const missing = candidates.filter((_, index) => !cached[index]);
  if (missing.length) {
    const batch = source.candidatesToCss(missing).then((outputs) => {
      let bytes = 0;
      return outputs.map((css) => {
        if (css === null) return EMPTY_CLASSES;
        bytes += Buffer.byteLength(css, "utf8");
        if (bytes > MAX_DESIGN_TAILWIND_FRAME_CSS_BYTES) throw new Error("Tailwind class output exceeded the frame budget.");
        return extractDesignClassCatalog(css);
      });
    });
    let next = 0;
    for (const [index, key] of keys.entries()) {
      if (cached[index]) continue;
      const at = next++;
      const pending = batch.then((catalogs) => catalogs[at] ?? null).catch(() => null);
      cached[index] = pending;
      designStyleCache.set(key, pending, 256 + key.length * 2);
      void pending.then((catalog) => {
        if (designStyleCache.get(key) === pending) {
          designStyleCache.set(key, pending, (catalog?.bytes ?? 64) + 128 + key.length * 2);
        }
      });
    }
  }
  return Promise.all(cached.map((value) => value!));
}

/** Built once per lint; source selection and linked reads are shared across
 * its frames. Cross-snapshot catalogs use the same bounded cache as rendering. */
export async function designKnownClasses(workspacePath: string, context?: DesignCanvasReadContext): Promise<DesignKnownClasses> {
  const root = path.resolve(workspacePath);
  const directory = designDirectory(root);
  try {
    const canvas = context?.canvas ?? await readCanvas(root);
    const catalog = readDesignStyleSourceCatalog(canvas);
    const report = await readDesignStyleSources(root, canvas);
    const byId = new Map(report.sources.map((source) => [source.id, source]));
    const declarations = new Map(catalog.declarations.map((source) => [source.id, source]));
    const imported = new Map<string, Promise<ImportedClasses | null>>();
    const selections = new Map<string, Promise<(ImportedClasses | null)[]>>();
    const linked = new Map<string, Promise<{ catalog: DesignClassCatalog; variables: string[] } | null>>();

    const sourceClasses = (id: string): Promise<ImportedClasses | null> => {
      let pending = imported.get(id);
      if (!pending) {
        pending = (async () => {
          const source = byId.get(id);
          if (!source || source.status === "error" || source.revision === null) return null;
          if (source.kind === "tailwind") {
            const declaration = declarations.get(id);
            const tailwind = declaration ? await designTailwindClassSource(root, declaration) : null;
            if (!tailwind) return null;
            const classes = cssClasses(root, tailwind.css, `tailwind\0${tailwind.revision}`);
            return classes ? { catalog: classes, tailwind } : null;
          }
          if (source.css === null) return null;
          const classes = cssClasses(root, source.css, source.revision);
          return classes ? { catalog: classes } : null;
        })().catch(() => null);
        imported.set(id, pending);
      }
      return pending;
    };

    return async (file, expandedHtml, document) => {
      try {
        const ids = frameStyleSourceIds(canvas, catalog, file);
        const optedOut = ids.length === 0 && Array.isArray((canvas.frame_info[file] as Record<string, unknown> | undefined)?.styles);
        if (!optedOut && report.errors.length) return null;
        const selectionKey = `${optedOut ? "none" : "sources"}\0${ids.join("\0")}`;
        let selection = selections.get(selectionKey);
        if (!selection) {
          selection = (async () => {
            if (optedOut) return [];
            const chosen = await Promise.all(ids.map(sourceClasses));
            const fonts = await designFrameClassFonts(root, canvas, ids.flatMap((id) => byId.get(id)?.fontImports ?? []));
            if (!fonts.complete) return [null];
            if (fonts.source) {
              const classes = cssClasses(root, fonts.source.css!, fonts.source.revision!);
              chosen.unshift(classes ? { catalog: classes } : null);
            }
            return chosen;
          })().catch(() => [null]);
          selections.set(selectionKey, selection);
        }
        const sources = await selection;
        if (sources.some((source) => source === null)) return null;
        const classes = sources.map((source) => source!.catalog);
        const local: DesignClassCatalog = { names: new Set(), attributes: [], bytes: 0 };
        const include = (catalog: DesignClassCatalog) => {
          for (const name of catalog.names) local.names.add(name);
          local.attributes.push(...catalog.attributes);
        };
        classes.unshift(local);
        const variables = new Set<string>();
        let linkCount = 0;
        const parsed = document ?? parse(expandedHtml);
        for (const { element } of elementRecords(parsed)) {
          if (element.tagName === "style") {
            const css = element.childNodes.map((node) => "value" in node ? node.value : "").join("");
            const own = cssClasses(root, css);
            if (!own) return null;
            include(own);
          } else if (element.tagName === "link") {
            const rel = element.attrs.find((attribute) => attribute.name === "rel")?.value ?? "";
            if (!rel.split(/[\t\n\f\r ]+/).some((token) => token.toLowerCase() === "stylesheet")) continue;
            if (++linkCount > MAX_STYLESHEETS_PER_FRAME) return null;
            const href = element.attrs.find((attribute) => attribute.name === "href")?.value ?? "";
            const resolved = safeLocalReference(directory, href, file);
            if (!resolved?.toLowerCase().endsWith(".css")) return null;
            let pending = linked.get(resolved);
            if (!pending) {
              pending = readSafeDesignText(directory, resolved).then((css) => {
                if (css === null) return null;
                const catalog = cssClasses(root, css);
                return catalog ? { catalog, variables: designTailwindVariables(css) } : null;
              });
              linked.set(resolved, pending);
            }
            const sheet = await pending;
            if (!sheet) return null;
            include(sheet.catalog);
            for (const variable of sheet.variables) variables.add(variable);
          }
        }
        const tailwind = sources.flatMap((source) => source?.tailwind ? [source.tailwind] : []);
        if (tailwind.length) {
          const candidates = designTailwindCandidates(expandedHtml, [...variables], parsed);
          // Candidates past the cap are never classified, so they are unknown.
          if (candidates.length >= MAX_TAILWIND_CANDIDATES) return null;
          for (const source of tailwind) {
            const generated = await candidateClasses(root, source, candidates);
            if (generated.some((entry) => entry === null)) return null;
            for (const catalog of generated) include(catalog!);
          }
        }
        return { has: (name) => DESIGN_CLASS_MARKERS.test(name) || classes.some((catalog) => designCatalogHasClass(catalog, name)) };
      } catch {
        return null;
      }
    };
  } catch {
    // A failed advisory catalog must neither invent warnings nor hide the
    // safety, token and component diagnostics that the frame still supplies.
    return async () => null;
  }
}
