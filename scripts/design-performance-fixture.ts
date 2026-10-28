/** Generate a disposable, real Local checkout before native qualification.
 * Uses the ordinary registration/frame writers; never modifies an existing
 * directory, stages files, or changes the product's 256-frame limit. */
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { initializeDesignDocument, createDesignFrame } from "../apps/desktop/src/engine/design/document";
import { designDirectoryNameFor } from "../apps/desktop/src/engine/design/directory-registry";

async function main() {
const args = process.argv.slice(2);
const argument = (name: string) => {
  const index = args.indexOf(name);
  const value = index < 0 ? undefined : args[index + 1];
  if (index >= 0 && (!value || value.startsWith("--"))) throw new Error(`${name} requires a value.`);
  return value;
};
const count = Number(argument("--frames") ?? "32");
if (![2, 32, 128, 256].includes(count)) throw new Error("Use --frames 2, 32, 128 or 256.");
const output = path.resolve(argument("--output") ?? `.context/design-performance-fixture-${count}`);
const complex = args.includes("--complex");
const mixed = args.includes("--mixed");
const layout = argument("--layout") ?? "grid";
if (layout !== "grid" && layout !== "fixed-view") throw new Error("Use --layout grid or fixed-view.");
// mkdir without recursive refuses an existing checkout, including a symlink.
await mkdir(output);
execFileSync("git", ["init", "-q"], { cwd: output });
await initializeDesignDocument(output);
const directory = designDirectoryNameFor(output);
const root = path.join(output, directory);
await writeFile(path.join(root, "performance.css"), `
*{box-sizing:border-box}body{margin:0;font:16px system-ui;background:#fafafa;color:#222}
main{padding:24px}.cards{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}
.card{display:flex;flex-direction:column;gap:8px;padding:12px;border:1px solid #ddd;border-radius:12px;background:linear-gradient(135deg,#fff,#e9f1ff)}
h1{font-size:24px;margin:0 0 20px}h2,p{margin:0}h2{font-size:14px}p{font-size:12px;line-height:1.5}
.effect{filter:drop-shadow(0 2px 4px #0003)}svg{width:100%;height:32px}img{width:24px;height:24px}
`);
// Authored 24px RGBA circle. External SVG references are intentionally not
// supported; use an actual supported image so native runs include decoding.
await writeFile(path.join(root, "performance.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAABgAAAAYCAYAAADgdz34AAAAVUlEQVR4nGMIqn/KQEtMU8NJseA/DkyxBbgMJtoiSg0maBE1DcdqCd0toNRwDEvoagG1DEexZNSCEWbB0M8Hw6MsoktxTZcKh1iLCOol1gKyMc0tAABSihSQfE70tAAAAABJRU5ErkJggg==", "base64"));
const files: string[] = [];
for (let index = 0; index < count; index++) {
  const distant = layout === "fixed-view" && index >= 2;
  const frame = await createDesignFrame(output, { title: `Performance ${index + 1}`,
    ...(mixed && index % 2 ? { seed: { kind: "text" as const, nodeId: "native-text", text: "Native transparent text — crisp type, no opaque artboard", fixedSize: true } } : {}),
    geometry: { x: (distant ? 20_000 : 0) + (index % 16) * 640,
      y: (distant ? 20_000 : 0) + Math.floor(index / 16) * 440, w: 560, h: 360, z: index } });
  files.push(frame.file);
}
for (const [index, file] of files.entries()) {
  if (mixed && index % 2) continue; // Keep the ordinary transparent text seed.
  const prefix = file.includes("/") ? "../" : "";
  const cards = Array.from({ length: complex ? 48 : 3 }, (_, card) => `
    <article class="card" data-oid="card-${card}"><h2 data-oid="heading-${card}">Item ${card + 1}</h2>
    <p data-oid="copy-${card}">Text, layout and image detail for the same reproducible viewport.</p>
    <img data-oid="image-${card}" src="${prefix}performance.png" alt=""/>
    ${complex ? `<svg class="effect" data-oid="vector-${card}" viewBox="0 0 100 32"><path d="M0 28 Q25 0 50 16 T100 4" stroke="#527fe5" stroke-width="2" fill="none"/></svg>` : ""}</article>`).join("");
  await writeFile(path.join(root, file), `<!doctype html><html><head><link rel="stylesheet" href="${prefix}performance.css"></head><body><main data-oid="scene" data-zeros-frame-root><h1 data-oid="title">Performance ${index + 1}</h1><div class="cards" data-oid="cards">${cards}</div></main></body></html>`);
}
console.log(JSON.stringify({ workspace: output, designDirectory: directory, frames: count, layout, mixed,
  complexity: complex ? "48 cards per frame, flex/grid, SVG, local images and effects" : "3 cards per frame",
  fonts: "system font", next: "Open this checkout as a Local workspace in the exact Electron build. Record fixed-view, overview, editing/capture, hidden, and owner-switch scenarios separately." }, null, 2));
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
