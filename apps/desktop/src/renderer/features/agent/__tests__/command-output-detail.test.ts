import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { renderDetail } from "../renderers/event-row-renderer";
import type { AgentToolMessage } from "../use-agent-session";
import type { RendererContext } from "../renderers/types";

vi.mock("../renderers/highlighted-code", () => ({
  HighlightedCode: ({ code, lang }: { code: string; lang: string }) => createElement("pre", { "data-lang": lang }, code),
  CodeWithGutter: ({ code, lang, startLine }: { code: string; lang: string; startLine: number }) =>
    createElement("pre", { "data-lang": lang, "data-start": startLine }, code),
}));
vi.mock("../renderers/diff-hover-preview", () => ({
  DiffHoverPreview: ({ path, patch }: { path: string; patch: string }) => createElement("output", { "data-diff": path }, patch),
}));
vi.mock("../markdown", () => ({ renderMarkdown: (text: string) => text }));

const diff = "diff --git a/w.ts b/w.ts\nindex 1..2 100644\n--- a/w.ts\n+++ b/w.ts\n@@ -1,2 +1,2 @@\n a\n-b\n+c";
const PLACEMENTS = [
  ["Local Personal", "/Users/someone/projects/app"],
  ["organization-local", "/Users/someone/work/app"],
  ["cloud", "cloud://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222"],
] as const;

describe.each(PLACEMENTS)("expanded command output (%s)", (_placement, cwd) => {
  function run(command: string, output: string, status: AgentToolMessage["status"] = "completed", exitCode = status === "failed" ? 2 : 0): string {
    const tool: AgentToolMessage = {
      kind: "tool", id: "tool-t", toolCallId: "t", title: "Bash", toolKind: "execute", status, createdAt: 1, updatedAt: 2,
      rawInput: { command }, rawOutput: { exitCode, stdout: output },
    };
    return renderToStaticMarkup(renderDetail(tool, { attachmentImagesActive: true, attachmentCwd: cwd, chatId: cwd } as RendererContext));
  }

  it("renders a diff in the output as a diff and keeps the rest as text", () => {
    const html = run("wc -c *.ts; git diff -- w.ts", ` 52128 ./main.ts\n${diff}\n`);
    expect(html).toContain('<pre data-lang="text"> 52128 ./main.ts</pre>');
    expect(html).toContain(`<output data-diff="w.ts">${diff}\n</output>`);
  });

  it("highlights a printed file in its language from the printed line", () => {
    const html = run("sed -n '120,121p' src/app.tsx", "const a = 1;\nconst b = 2;\n");
    expect(html).toContain('data-lang="tsx" data-start="120"');
  });

  it("keeps failed and ordinary commands as plain text", () => {
    expect(run("cat src/app.tsx", "cat: src/app.tsx: No such file", "failed")).not.toContain('data-lang="tsx"');
    expect(run("ls", "a.ts\nb.ts")).toContain('<pre data-lang="text">a.ts\nb.ts</pre>');
    expect(run("git diff", diff, "failed")).not.toContain("data-diff");
  });

  it("renders a comparison's differences although its exit code 1 marked the tool failed", () => {
    const plain = "--- old.txt\t2026-01-01\n+++ new.txt\t2026-01-02\n@@ -1 +1 @@\n-a\n+b";
    expect(run("diff -u old.txt new.txt", plain, "failed", 1)).toContain('<output data-diff="new.txt">');
    expect(run("diff -u old.txt missing.txt", "diff: missing.txt: No such file or directory", "failed", 2)).not.toContain("data-diff");
    expect(run("cat a.ts", plain, "failed", 1)).not.toContain("data-diff");
  });

  it("numbers a printed text file from its first line", () => {
    expect(run("sed -n '40,41p' notes.txt", "a\nb\n")).toContain('data-lang="text" data-start="40"');
  });
});
