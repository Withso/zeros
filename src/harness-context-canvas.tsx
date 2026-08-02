// Standalone development harness — NOT part of the shipped app.
//
// An isolated repro page for the Context tab's canvas, served by `pnpm dev`
// at /harness-context-canvas.html. It mounts ContextGraphCanvas with mock
// graph items (no engine, no IPC) so pan/zoom, the auto-layout bands, card
// variants, and the share checkbox can be exercised and screenshotted
// without booting the whole shell.
import "../styles/zeros-tokens.css";
import "../styles/semantic-tokens.css";
import "../styles/globals.css";

async function main() {
  const React = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { TooltipProvider } = await import("./zeros/ui/primitives/tooltip");
  const { ContextGraphCanvas } = await import(
    "./shell/column3-tabs/context-graph-canvas"
  );
  type Item = import("./native/context-graph").ContextGraphItemWire;

  // A tiny inline PNG (4×4 orange) so image cards render without any IPC —
  // the harness monkey-patches nothing; missing reads just show the icon
  // fallback, which is itself a state worth eyeballing.
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
  ];
  const docs: Item[] = [
    {
      relPath: ".context-graph/shared/docs/handoff.md",
      name: "handoff.md",
      scope: "shared",
      category: "doc",
      kind: "markdown",
      bytes: 2_048,
      mtimeMs: 6,
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
      mtimeMs: 7,
      previewText: "private scratchpad — never committed",
    },
  ];

  function Harness() {
    const [pending, setPending] = React.useState<ReadonlySet<string>>(
      () => new Set(),
    );
    const [items, setItems] = React.useState<Item[]>([
      ...attachments,
      ...docs,
    ]);
    const toggle = async (attachmentId: string, shared: boolean) => {
      setPending((p) => new Set(p).add(attachmentId));
      await new Promise((r) => setTimeout(r, 350));
      setItems((prev) =>
        prev.map((i) =>
          i.attachmentId === attachmentId
            ? { ...i, scope: shared ? "shared" : "local" }
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
          />
        </div>
      </TooltipProvider>
    );
  }

  createRoot(document.getElementById("root")!).render(<Harness />);
}

void main();
