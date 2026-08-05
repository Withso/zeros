// Tests for the shared markdown discovery module.
//
// This module backs the composer's slash-command + subagent pickers
// for Claude, Codex, and Cursor. A regression in
// frontmatter parsing, precedence, or YAML edge-cases shows up as
// missing/duplicate commands in the picker — visual, not loud.
// These tests pin the wire format so the next refactor breaks the
// suite, not the user's composer.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// os.homedir() is non-configurable on the imported namespace, so we
// stub the whole module before importing discovery. The mocked homedir
// reads from a shared `fakeHome` variable that precedence tests update.
let fakeHome = "";
vi.mock("node:os", async (importActual) => {
  const actual = await importActual<typeof import("node:os")>();
  return {
    ...actual,
    homedir: () => (fakeHome ? fakeHome : actual.homedir()),
  };
});

import {
  discoverCommands,
  resolveCommandRoots,
  scanCommandDir,
} from "../discovery";

async function writeMd(filePath: string, content: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf-8");
}

describe("resolveCommandRoots", () => {
  const cwd = "/fake/cwd";

  it("returns workspace + user-home dirs for claude", () => {
    const roots = resolveCommandRoots({ agentId: "claude", cwd });
    expect(roots.length).toBe(2);
    expect(roots[0]).toContain(".claude/commands");
    expect(roots[0].startsWith(cwd)).toBe(true);
    expect(roots[1]).toContain(".claude/commands");
    expect(roots[1].startsWith(cwd)).toBe(false);
  });

  it("returns workspace + $CODEX_HOME prompts dirs for codex", () => {
    // Codex custom prompts live in $CODEX_HOME/prompts (default
    // ~/.codex/prompts) and surface as slash commands; we also scan a
    // workspace-level .codex/prompts for parity.
    const roots = resolveCommandRoots({ agentId: "codex", cwd });
    expect(roots.length).toBe(2);
    expect(roots[0]).toBe(path.join(cwd, ".codex", "prompts"));
    expect(roots[1]).toContain("prompts");
    expect(roots[1].startsWith(cwd)).toBe(false);
  });

  it("returns empty for unknown agent", () => {
    expect(resolveCommandRoots({ agentId: "nonexistent", cwd })).toEqual([]);
  });
});

describe("scanCommandDir", () => {
  let workdir: string;

  beforeEach(async () => {
    workdir = await mkdtemp(path.join(tmpdir(), "zeros-discovery-test-"));
  });

  afterEach(async () => {
    try {
      await rm(workdir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });

  it("returns [] for missing directory", async () => {
    const out = await scanCommandDir(path.join(workdir, "does-not-exist"));
    expect(out).toEqual([]);
  });

  it("returns [] for empty directory", async () => {
    await mkdir(workdir, { recursive: true });
    const out = await scanCommandDir(workdir);
    expect(out).toEqual([]);
  });

  it("ignores non-.md files", async () => {
    await writeMd(path.join(workdir, "foo.txt"), "ignored");
    await writeMd(path.join(workdir, "bar.json"), "{}");
    const out = await scanCommandDir(workdir);
    expect(out).toEqual([]);
  });

  it("parses a full frontmatter command", async () => {
    await writeMd(
      path.join(workdir, "deploy.md"),
      `---
name: deploy
description: Deploy the app to production
input:
  hint: "<environment>"
---

Run the deploy pipeline.
`,
    );
    const out = await scanCommandDir(workdir);
    expect(out).toEqual([
      {
        name: "deploy",
        description: "Deploy the app to production",
        input: { hint: "<environment>" },
        // File-based discovery only finds user-authored commands (never skills).
        kind: "command",
      },
    ]);
  });

  it("falls back to basename when frontmatter omits name", async () => {
    await writeMd(
      path.join(workdir, "my-cmd.md"),
      `---
description: A command
---
`,
    );
    const out = await scanCommandDir(workdir);
    expect(out[0]?.name).toBe("my-cmd");
  });

  it("falls back to first body line when description missing", async () => {
    await writeMd(
      path.join(workdir, "noop.md"),
      `---
name: noop
---

This is the first body line.
Followed by more text.
`,
    );
    const out = await scanCommandDir(workdir);
    expect(out[0]?.description).toBe("This is the first body line.");
  });

  it("treats a file with no frontmatter as basename + first line", async () => {
    await writeMd(
      path.join(workdir, "plain.md"),
      "Just a description, no frontmatter.\n",
    );
    const out = await scanCommandDir(workdir);
    expect(out[0]).toEqual({
      name: "plain",
      description: "Just a description, no frontmatter.",
      kind: "command",
    });
  });

  it("tolerates malformed frontmatter without throwing", async () => {
    await writeMd(
      path.join(workdir, "broken.md"),
      `---
this is not valid yaml: : ::
name without colon
---

body line
`,
    );
    const out = await scanCommandDir(workdir);
    // Either parses what it can or treats as no-frontmatter; must not throw.
    expect(out.length).toBe(1);
    expect(out[0]?.name).toBeTruthy();
  });

  it("strips quotes from string values", async () => {
    await writeMd(
      path.join(workdir, "q.md"),
      `---
name: "quoted-name"
description: 'single-quoted'
---
`,
    );
    const out = await scanCommandDir(workdir);
    expect(out[0]?.name).toBe("quoted-name");
    expect(out[0]?.description).toBe("single-quoted");
  });
});

describe("discoverCommands precedence", () => {
  let workdir: string;
  let workspace: string;
  let home: string;

  beforeEach(async () => {
    workdir = await mkdtemp(path.join(tmpdir(), "zeros-discovery-test-"));
    workspace = path.join(workdir, "workspace");
    home = path.join(workdir, "home");
    fakeHome = home;
  });

  afterEach(async () => {
    fakeHome = "";
    try {
      await rm(workdir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });

  it("workspace command overrides user command with same name", async () => {
    await writeMd(
      path.join(workspace, ".claude", "commands", "deploy.md"),
      "---\nname: deploy\ndescription: workspace version\n---\n",
    );
    await writeMd(
      path.join(home, ".claude", "commands", "deploy.md"),
      "---\nname: deploy\ndescription: user-home version\n---\n",
    );
    const out = await discoverCommands({ agentId: "claude", cwd: workspace });
    expect(out.length).toBe(1);
    expect(out[0]?.description).toBe("workspace version");
  });

  it("merges distinct names across workspace + user", async () => {
    await writeMd(
      path.join(workspace, ".claude", "commands", "ws-only.md"),
      "---\nname: ws-only\n---\n",
    );
    await writeMd(
      path.join(home, ".claude", "commands", "user-only.md"),
      "---\nname: user-only\n---\n",
    );
    const out = await discoverCommands({ agentId: "claude", cwd: workspace });
    expect(out.map((c) => c.name).sort()).toEqual(["user-only", "ws-only"]);
  });

  it("returns sorted by name", async () => {
    await writeMd(
      path.join(workspace, ".claude", "commands", "zeta.md"),
      "---\nname: zeta\n---\n",
    );
    await writeMd(
      path.join(workspace, ".claude", "commands", "alpha.md"),
      "---\nname: alpha\n---\n",
    );
    await writeMd(
      path.join(workspace, ".claude", "commands", "mid.md"),
      "---\nname: mid\n---\n",
    );
    const out = await discoverCommands({ agentId: "claude", cwd: workspace });
    expect(out.map((c) => c.name)).toEqual(["alpha", "mid", "zeta"]);
  });

  it("returns [] for agent with no command dirs", async () => {
    const out = await discoverCommands({ agentId: "codex", cwd: workspace });
    expect(out).toEqual([]);
  });
});
