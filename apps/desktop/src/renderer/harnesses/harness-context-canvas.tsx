// Standalone development harness — NOT part of the shipped app.
//
// An isolated repro page for the Context tab's canvas, served by `pnpm dev`
// at /apps/desktop/src/renderer/harnesses/harness-context-canvas.html. It
// mounts ContextGraphCanvas with mock graph items (no engine, no IPC) so
// pan/zoom, the diamond layout, card variants, and the share checkbox can be
// exercised and screenshotted without booting the whole shell.
import "../../../../../styles/zeros-tokens.css";
import "../../../../../styles/semantic-tokens.css";
import "../../../../../styles/globals.css";

async function main() {
  const React = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { TooltipProvider } = await import("../shared/ui/primitives/tooltip");
  const { ContextGraphCanvas } =
    await import("../shell/workbench/tabs/context-graph-canvas");
  type Item = import("../platform/context-graph").ContextGraphItemWire;

  /** Paint cheap deterministic image stand-ins at several aspect ratios so
   *  the browser-only harness exercises contain-fit without Electron IPC. */
  const loadHarnessThumbnail = async (
    _cwd: string,
    relPath: string,
    maxDimension: 256 | 512 | 1024 | 1536 = 256,
  ) => {
    const seed = [...relPath].reduce(
      (sum, char) => sum + char.charCodeAt(0),
      0,
    );
    const shape = seed % 3;
    const width =
      shape === 0
        ? maxDimension
        : shape === 1
          ? Math.round(maxDimension * 0.5625)
          : maxDimension;
    const height =
      shape === 0
        ? Math.round(maxDimension * 0.5625)
        : shape === 1
          ? maxDimension
          : maxDimension;
    const hue = seed % 360;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="hsl(${hue} 34% 24%)"/><circle cx="${Math.round(width * 0.7)}" cy="${Math.round(height * 0.3)}" r="${Math.round(Math.min(width, height) * 0.18)}" fill="hsl(${(hue + 80) % 360} 62% 64%)"/><path d="M0 ${Math.round(height * 0.82)} L${Math.round(width * 0.42)} ${Math.round(height * 0.4)} L${width} ${Math.round(height * 0.88)} V${height} H0Z" fill="hsl(${(hue + 160) % 360} 42% 38%)"/></svg>`; // check:ui ignore-line (user data: harness-only thumbnail pixels)
    return {
      kind: "image" as const,
      path: relPath,
      bytes: svg.length,
      width,
      height,
      sourceWidth: shape === 1 ? 2_160 : 3_840,
      sourceHeight: shape === 0 ? 2_160 : 3_840,
      dataUrl: `data:image/svg+xml,${encodeURIComponent(svg)}`,
    };
  };

  const attachments: Item[] = [
    {
      relPath: ".context-graph/local/attachments/att-1/screenshot.png",
      name: "screenshot.png",
      scope: "local",
      category: "attachment",
      kind: "image",
      bytes: 246_964,
      mtimeMs: 1,
      attachmentId: "att-1",
    },
    {
      relPath: ".context-graph/shared/attachments/att-2/transcript.txt",
      name: "transcript.txt",
      scope: "shared",
      category: "attachment",
      kind: "text",
      bytes: 4_212,
      mtimeMs: 2,
      attachmentId: "att-2",
      previewText:
        "User\nhow @.context actually works?? does it tell the agents to use it as a playground? or artifacts?\nwhat are the instructions to these agents...",
    },
    {
      relPath: ".context-graph/local/attachments/att-3/notes.md",
      name: "notes.md",
      scope: "local",
      category: "attachment",
      kind: "markdown",
      bytes: 1_024,
      mtimeMs: 3,
      attachmentId: "att-3",
      previewText:
        "# Plan\n\n- ship the context graph\n- canvas with pan/zoom\n- checkbox = shared (not gitignored)\n\n> first version out now, improve later",
    },
    {
      relPath: ".context-graph/local/attachments/att-4/data.json",
      name: "data.json",
      scope: "local",
      category: "attachment",
      kind: "other",
      bytes: 88_121,
      mtimeMs: 4,
      attachmentId: "att-4",
    },
    {
      relPath: ".context-graph/shared/attachments/att-5/big-shot.png",
      name: "big-shot.png",
      scope: "shared",
      category: "attachment",
      kind: "image",
      bytes: 1_100_000,
      mtimeMs: 5,
      attachmentId: "att-5",
    },
    {
      relPath: ".context-graph/local/attachments/att-6/portrait.jpg",
      name: "portrait.jpg",
      scope: "local",
      category: "attachment",
      kind: "image",
      bytes: 410_000,
      mtimeMs: 6,
      attachmentId: "att-6",
    },
    {
      relPath: ".context-graph/local/attachments/att-7/banner.webp",
      name: "banner.webp",
      scope: "local",
      category: "attachment",
      kind: "image",
      bytes: 190_000,
      mtimeMs: 7,
      attachmentId: "att-7",
    },
    {
      relPath: ".context-graph/local/attachments/att-8/context-card.tsx",
      name: "context-card.tsx",
      scope: "local",
      category: "attachment",
      kind: "other",
      bytes: 8_800,
      mtimeMs: 8,
      attachmentId: "att-8",
      previewText:
        'export function ContextCard() {\n  return <article data-kind="attachment" />;\n}',
    },
    {
      relPath: ".context-graph/shared/attachments/att-9/config.toml",
      name: "config.toml",
      scope: "shared",
      category: "attachment",
      kind: "other",
      bytes: 1_800,
      mtimeMs: 9,
      attachmentId: "att-9",
      previewText: '[canvas]\nlayout = "diamond"\nthumbnail_size = 256',
    },
    {
      relPath: ".context-graph/local/attachments/att-10/setup.sh",
      name: "setup.sh",
      scope: "local",
      category: "attachment",
      kind: "other",
      bytes: 780,
      mtimeMs: 10,
      attachmentId: "att-10",
    },
    {
      relPath: ".context-graph/local/attachments/att-11/reference.bin",
      name: "reference.bin",
      scope: "local",
      category: "attachment",
      kind: "other",
      bytes: 64_000,
      mtimeMs: 11,
      attachmentId: "att-11",
    },
  ];
  const docs: Item[] = [
    {
      relPath: ".context-graph/shared/docs/handoff.md",
      name: "handoff.md",
      scope: "shared",
      category: "doc",
      kind: "markdown",
      bytes: 2_048,
      mtimeMs: 12,
      previewText:
        "# Handoff\n\nThe worktree is clean; Changes tab shows the shared attachments only.\nSee .context-graph/shared for the docs the team can read.",
    },
    {
      relPath: ".context-graph/local/scratch.txt",
      name: "scratch.txt",
      scope: "local",
      category: "doc",
      kind: "text",
      bytes: 512,
      mtimeMs: 13,
      previewText: "private scratchpad — never committed",
    },
  ];
  const largeGraphItems = new URLSearchParams(window.location.search).has(
    "large",
  )
    ? Array.from(
        { length: 400 },
        (_, index): Item => ({
          relPath: `.context-graph/local/attachments/perf-${index}/image-${index}.png`,
          name: `image-${index}.png`,
          scope: "local",
          category: "attachment",
          kind: "image",
          bytes: 240_000,
          mtimeMs: index + 1,
          attachmentId: `perf-${index}`,
        }),
      )
    : null;

  function Harness() {
    const [pending, setPending] = React.useState<ReadonlySet<string>>(
      () => new Set(),
    );
    const [items, setItems] = React.useState<Item[]>(
      largeGraphItems ?? [...attachments, ...docs],
    );
    const toggle = async (attachmentId: string, shared: boolean) => {
      setPending((p) => new Set(p).add(attachmentId));
      await new Promise((r) => setTimeout(r, 350));
      setItems((prev) =>
        prev.map((i) =>
          i.attachmentId === attachmentId
            ? {
                ...i,
                scope: shared ? "shared" : "local",
                relPath: i.relPath.replace(
                  /^\.context-graph\/(?:local|shared)\//,
                  `.context-graph/${shared ? "shared" : "local"}/`,
                ),
              }
            : i,
        ),
      );
      setPending((p) => {
        const n = new Set(p);
        n.delete(attachmentId);
        return n;
      });
    };
    return (
      <TooltipProvider>
        <div className="bg-bg1 flex h-dvh flex-col">
          <ContextGraphCanvas
            cwd="/repo/harness"
            items={items}
            active
            onToggleShared={toggle}
            pendingToggles={pending}
            imageThumbnailLoader={loadHarnessThumbnail}
          />
        </div>
      </TooltipProvider>
    );
  }

  createRoot(document.getElementById("root")!).render(<Harness />);
}

void main();
