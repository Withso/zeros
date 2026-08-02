// The Files tab shows .gitignore'd entries — node_modules/, dist/, .env — that
// `listWorkspaceFiles` deliberately omits, because those are precisely what a
// setup script, an agent, or a terminal command produces. Two properties have
// to hold or the feature is either useless or dangerous:
//
//   • it must stay CHEAP. This repo has 60,888 ignored files; the roots listing
//     collapses them to ~8 rows, and children come one directory at a time.
//   • `dir` arrives from the renderer, so it must not become a
//     read-anything-on-disk primitive.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile, mkdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { listIgnoredEntries, listWorkspaceFiles } from "../workspace-files";
import { isSensitiveRepoPath } from "../../files/read-file";

const execFileAsync = promisify(execFile);

async function initRepo(dir: string): Promise<void> {
  await execFileAsync("git", ["init", "-q", "-b", "main"], { cwd: dir });
}

describe("listIgnoredEntries", () => {
  let workdir = "";

  beforeEach(async () => {
    workdir = await mkdtemp(path.join(tmpdir(), "zeros-ignored-"));
    await initRepo(workdir);
    await writeFile(
      path.join(workdir, ".gitignore"),
      "node_modules/\ndist/\n.env\n",
    );
    await writeFile(path.join(workdir, "index.ts"), "export {};\n");
    await mkdir(path.join(workdir, "src"), { recursive: true });
    await writeFile(path.join(workdir, "src", "app.ts"), "export {};\n");
    // The ignored side of the worktree.
    await writeFile(path.join(workdir, ".env"), "SECRET=1\n");
    await mkdir(path.join(workdir, "dist"), { recursive: true });
    await writeFile(path.join(workdir, "dist", "bundle.js"), "//\n");
    await mkdir(path.join(workdir, "node_modules", "react"), {
      recursive: true,
    });
    await writeFile(
      path.join(workdir, "node_modules", "react", "index.js"),
      "//\n",
    );
  });

  afterEach(async () => {
    await rm(workdir, { recursive: true, force: true });
  });

  it("returns the ignored roots the tracked listing hides", async () => {
    const roots = await listIgnoredEntries(workdir);
    expect(roots.sort()).toEqual([".env", "dist/", "node_modules/"]);
    // …and they are genuinely absent from the tracked listing, which is why
    // the Files tab could not show node_modules before.
    const tracked = await listWorkspaceFiles(workdir);
    expect(tracked).toContain("src/app.ts");
    expect(tracked.some((p) => p.startsWith("node_modules"))).toBe(false);
  });

  it("COLLAPSES a wholly-ignored directory to one entry, not its contents", async () => {
    // The whole feasibility of the feature: 60k ignored files must not become
    // 60k tree rows on first paint.
    for (let i = 0; i < 50; i++) {
      await mkdir(path.join(workdir, "node_modules", `pkg${i}`), {
        recursive: true,
      });
      await writeFile(
        path.join(workdir, "node_modules", `pkg${i}`, "index.js"),
        "//\n",
      );
    }
    const roots = await listIgnoredEntries(workdir);
    expect(roots).toContain("node_modules/");
    expect(roots.filter((p) => p.startsWith("node_modules")).length).toBe(1);
  });

  it("lists individual ignored files inside a MIXED directory", async () => {
    // `--directory` only collapses a WHOLLY ignored directory. A folder holding
    // both tracked and ignored files (generated output next to source) must
    // report its ignored children individually, or they'd be invisible — the
    // directory itself already exists in the tree from its tracked files.
    await mkdir(path.join(workdir, "docs"), { recursive: true });
    await writeFile(path.join(workdir, "docs", "guide.md"), "# hi\n");
    await writeFile(path.join(workdir, "docs", "guide.html"), "<p>\n");
    await writeFile(
      path.join(workdir, ".gitignore"),
      "node_modules/\ndist/\n.env\ndocs/*.html\n",
    );
    // Commit the tracked side: a real worktree is a checkout, and `--directory`
    // treats a directory with no tracked content as collapsible.
    await execFileAsync("git", ["-C", workdir, "add", "docs/guide.md", ".gitignore"]);
    await execFileAsync("git", [
      "-C", workdir, "-c", "user.email=t@t", "-c", "user.name=t",
      "commit", "-q", "-m", "docs",
    ]);
    const roots = await listIgnoredEntries(workdir);
    expect(roots).toContain("docs/guide.html");
    expect(roots).not.toContain("docs/");
  });

  it("lists an ignored file next to an UNTRACKED sibling in a new directory", async () => {
    // The case above passes for the wrong reason if the tracked sibling is
    // COMMITTED. `--no-empty-directory` drops a directory's ignored children
    // whenever the directory has no tracked content but does have untracked,
    // non-ignored content — so `--directory --no-empty-directory` returned
    // NOTHING here. That is exactly the shape an agent or a run action produces:
    // a brand-new folder holding a report next to a log.
    await mkdir(path.join(workdir, "out"), { recursive: true });
    await writeFile(path.join(workdir, "out", "report.md"), "# ok\n");
    await writeFile(path.join(workdir, "out", "run.log"), "built\n");
    await writeFile(
      path.join(workdir, ".gitignore"),
      "node_modules/\ndist/\n.env\n*.log\n",
    );
    const roots = await listIgnoredEntries(workdir);
    expect(roots).toContain("out/run.log");
    // …and the report, being neither tracked nor ignored, belongs to the OTHER
    // listing — this one must not claim it.
    expect(roots).not.toContain("out/report.md");
  });

  it("still suppresses a wholly-EMPTY ignored directory", async () => {
    // What `--no-empty-directory` is actually for: an empty ignored dir would
    // render as a row that expands to nothing. Keep that, without the collateral
    // damage above.
    await mkdir(path.join(workdir, "coverage"), { recursive: true });
    await mkdir(path.join(workdir, "empty-nest", "inner"), { recursive: true });
    await writeFile(
      path.join(workdir, ".gitignore"),
      "node_modules/\ndist/\n.env\ncoverage/\nempty-nest/\n",
    );
    const roots = await listIgnoredEntries(workdir);
    expect(roots).not.toContain("coverage/");
    // A directory holding only empty directories counts as empty too.
    expect(roots).not.toContain("empty-nest/");
    expect(roots).toContain("dist/"); // …and a non-empty one still shows
  });

  it("suppresses an ignored dir whose only content is a nested .git", async () => {
    // The tree never shows `.git` at any depth (readIgnoredDir drops it), so
    // a vendored checkout cleaned down to its object store would render as a
    // row that expands to nothing — the emptiness probe must not count what
    // the expansion will hide.
    await mkdir(path.join(workdir, "vendor", "emptydep"), { recursive: true });
    await initRepo(path.join(workdir, "vendor", "emptydep"));
    await mkdir(path.join(workdir, "vendor2", "realdep"), { recursive: true });
    await initRepo(path.join(workdir, "vendor2", "realdep"));
    await writeFile(
      path.join(workdir, "vendor2", "realdep", "index.js"),
      "//\n",
    );
    await writeFile(
      path.join(workdir, ".gitignore"),
      "node_modules/\ndist/\n.env\nvendor/\nvendor2/\n",
    );
    const roots = await listIgnoredEntries(workdir);
    expect(roots).not.toContain("vendor/");
    // …while a checkout that still holds real files keeps its row.
    expect(roots).toContain("vendor2/");
  });

  // ── The .context-graph shape: a self-ignoring folder whose ignored dir
  // sits NEXT TO an ignored file and a (possibly empty) not-ignored sibling.
  // This is what every workspace's composer-attachment store looks like, and
  // it broke the old `--no-empty-directory` keep-set two distinct ways. ──

  it("keeps an ignored dir when git's empty-dir run collapses at a HIGHER level", async () => {
    // Scaffold + one staged attachment, shared/ still empty. Git's plain
    // --directory run emits `.context-graph/.gitignore` + `.context-graph/local/`,
    // but the --no-empty-directory run collapses the WHOLE folder to
    // `.context-graph/` — so an exact-path keep-set dropped `local/` as
    // "empty" and the Files tab hid every composer attachment.
    await mkdir(path.join(workdir, ".context-graph", "local", "attachments", "AbC123"), {
      recursive: true,
    });
    await mkdir(path.join(workdir, ".context-graph", "shared", "attachments"), {
      recursive: true,
    });
    await writeFile(
      path.join(workdir, ".context-graph", ".gitignore"),
      "/.gitignore\n/local/\n",
    );
    await writeFile(
      path.join(workdir, ".context-graph", "local", "attachments", "AbC123", "shot.png"),
      "png\n",
    );
    const roots = await listIgnoredEntries(workdir);
    expect(roots).toContain(".context-graph/local/");
    expect(roots).toContain(".context-graph/.gitignore");
    // …and the attachment itself is one lazy expansion away, not flattened
    // into the roots payload.
    expect(await listIgnoredEntries(workdir, ".context-graph/local")).toEqual([
      ".context-graph/local/attachments/",
    ]);
  });

  it("keeps an ignored dir whose sibling holds untracked, non-ignored content", async () => {
    // Same store once something is SHARED: shared/ now holds an untracked,
    // non-ignored file, and `--directory --no-empty-directory` returns
    // NOTHING for the subtree (the out/report.md pathology, eating a
    // directory this time). The probe-based listing must not care.
    await mkdir(path.join(workdir, ".context-graph", "local", "attachments", "AbC123"), {
      recursive: true,
    });
    await mkdir(path.join(workdir, ".context-graph", "shared", "attachments", "xY42"), {
      recursive: true,
    });
    await writeFile(
      path.join(workdir, ".context-graph", ".gitignore"),
      "/.gitignore\n/local/\n",
    );
    await writeFile(
      path.join(workdir, ".context-graph", "local", "attachments", "AbC123", "shot.png"),
      "png\n",
    );
    await writeFile(
      path.join(workdir, ".context-graph", "shared", "attachments", "xY42", "notes.md"),
      "# shared\n",
    );
    const roots = await listIgnoredEntries(workdir);
    expect(roots).toContain(".context-graph/local/");
    // The shared file is untracked-not-ignored: the OTHER listing's territory.
    expect(roots.some((p) => p.includes("shared"))).toBe(false);
    const tracked = await listWorkspaceFiles(workdir);
    expect(tracked).toContain(".context-graph/shared/attachments/xY42/notes.md");
  });

  it("still suppresses the ignored dir while it holds no files at all", async () => {
    // The freshly-scaffolded store: local/attachments/ exists but is empty.
    // The ignored FILE next to it must survive; the empty dir must not
    // become a dead row.
    await mkdir(path.join(workdir, ".context-graph", "local", "attachments"), {
      recursive: true,
    });
    await mkdir(path.join(workdir, ".context-graph", "shared", "attachments"), {
      recursive: true,
    });
    await writeFile(
      path.join(workdir, ".context-graph", ".gitignore"),
      "/.gitignore\n/local/\n",
    );
    const roots = await listIgnoredEntries(workdir);
    expect(roots).toContain(".context-graph/.gitignore");
    expect(roots).not.toContain(".context-graph/local/");
  });

  it("marks a SYMLINKED ignored directory as expandable in the roots listing", async () => {
    // `git ls-files --directory` classifies a symlink as a file, so a symlinked
    // ignored dir inside a MIXED directory came back with no trailing slash —
    // a leaf row that opens file.read on a directory. readIgnoredDir already
    // stats symlinks; the two halves have to agree.
    await mkdir(path.join(workdir, "shared", "legacy"), { recursive: true });
    await mkdir(path.join(workdir, "packages"), { recursive: true });
    await writeFile(path.join(workdir, "packages", "keep.ts"), "export {};\n");
    await symlink(
      path.join(workdir, "shared", "legacy"),
      path.join(workdir, "packages", "legacy"),
    );
    await writeFile(
      path.join(workdir, ".gitignore"),
      "node_modules/\ndist/\n.env\nshared/\npackages/legacy\n",
    );
    await execFileAsync("git", ["-C", workdir, "add", "packages/keep.ts", ".gitignore"]);
    await execFileAsync("git", [
      "-C", workdir, "-c", "user.email=t@t", "-c", "user.name=t",
      "commit", "-q", "-m", "pkgs",
    ]);
    expect(await listIgnoredEntries(workdir)).toContain("packages/legacy/");
  });

  it("sorts BEFORE capping, so the cap is stable across calls", async () => {
    // Slicing readdir order would return an arbitrary subset that reshuffles
    // between calls — the renderer's "did this directory change?" check would
    // then fire on every refresh forever.
    for (const name of ["z.js", "m.js", "a.js", "b.js", "y.js"]) {
      await writeFile(path.join(workdir, "dist", name), "//\n");
    }
    const first = await listIgnoredEntries(workdir, "dist", 3);
    expect(first).toEqual(await listIgnoredEntries(workdir, "dist", 3));
    expect(first).toEqual([...first].sort());
    expect(first).toHaveLength(3);
  });

  it("returns canonical paths, whatever spelling `dir` arrives in", async () => {
    // A non-canonical prefix would produce rows under a phantom "." node that
    // no tree path matches, and the directory would never leave the pending set.
    expect(await listIgnoredEntries(workdir, "node_modules/./react")).toEqual([
      "node_modules/react/index.js",
    ]);
    expect(await listIgnoredEntries(workdir, "node_modules/")).toEqual([
      "node_modules/react/",
    ]);
  });

  it("lists one level inside an ignored directory on demand", async () => {
    const children = await listIgnoredEntries(workdir, "node_modules");
    expect(children).toEqual(["node_modules/react/"]);
    const grandchildren = await listIgnoredEntries(
      workdir,
      "node_modules/react",
    );
    expect(grandchildren).toEqual(["node_modules/react/index.js"]);
  });

  it("marks directories with a trailing slash and files without", async () => {
    // @pierre/trees keys off exactly this to build a directory node that has
    // no children yet — i.e. an unexpanded `node_modules/` row.
    const children = await listIgnoredEntries(workdir, "dist");
    expect(children).toEqual(["dist/bundle.js"]);
    expect((await listIgnoredEntries(workdir, "node_modules"))[0]).toMatch(/\/$/);
  });

  it("treats a SYMLINKED directory as expandable", async () => {
    // pnpm builds node_modules almost entirely from symlinks, whose Dirent
    // reports isDirectory() === false — without the stat they would all render
    // as unexpandable files.
    await mkdir(path.join(workdir, "store", "vue"), { recursive: true });
    await symlink(
      path.join(workdir, "store", "vue"),
      path.join(workdir, "node_modules", "vue"),
    );
    const children = await listIgnoredEntries(workdir, "node_modules");
    expect(children).toContain("node_modules/vue/");
  });

  it("does not list .git — it is excluded structurally, not ignored", async () => {
    const roots = await listIgnoredEntries(workdir);
    expect(roots.some((p) => p.startsWith(".git/"))).toBe(false);
  });

  it("does not list a NESTED .git reached by descending an ignored dir", async () => {
    // The roots query gets .git exclusion from git. readIgnoredDir is a plain
    // readdir, so it has to drop it itself — and it genuinely turns up: a
    // git-URL dependency under an ignored `vendor/`, or a sibling worktree
    // under the gitignored `.conductor/`, puts a real object store (or a .git
    // pointer file) one level down. Browsing it invites corruption, and
    // file.write is a sibling op.
    await mkdir(path.join(workdir, "vendor", "dep"), { recursive: true });
    await initRepo(path.join(workdir, "vendor", "dep"));
    await writeFile(path.join(workdir, "vendor", "dep", "index.js"), "//\n");
    await writeFile(
      path.join(workdir, ".gitignore"),
      "node_modules/\ndist/\n.env\nvendor/\n",
    );
    const children = await listIgnoredEntries(workdir, "vendor/dep");
    expect(children).toEqual(["vendor/dep/index.js"]);
    expect(children).not.toContain("vendor/dep/.git/");
    // …and asking for one by name is refused too, at any depth and however it
    // is spelled — the renderer can only ever echo back a path this function
    // produced, but `dir` crosses a bridge, so the guard doesn't rely on that.
    for (const probe of [
      ".git",
      ".git/refs",
      "vendor/dep/.git",
      "node_modules/../.git",
      "vendor/dep/.git/objects",
    ]) {
      expect(
        await listIgnoredEntries(workdir, probe),
        `"${probe}" must not list anything`,
      ).toEqual([]);
    }
  });

  it("caps BEFORE stat-ing entries, and orders by bytes not locale", async () => {
    // Two properties in one: the cap must not pay for work it throws away (the
    // stat loop is per-symlink and re-runs for every open directory on every
    // refresh), and the order must be locale-free. `localeCompare` returns 0 for
    // canonically-equivalent names, which makes the sort non-total, so the
    // "stable prefix" property the cap depends on silently didn't hold.
    for (const name of ["z.js", "ä.js", "a.js", "ö.js", "o.js"]) {
      await writeFile(path.join(workdir, "dist", name), "//\n");
    }
    const all = await listIgnoredEntries(workdir, "dist");
    expect(all).toEqual([...all].sort()); // codepoint order, not ICU order
    const capped = await listIgnoredEntries(workdir, "dist", 3);
    expect(capped).toEqual(all.slice(0, 3));
    expect(capped).toEqual(await listIgnoredEntries(workdir, "dist", 3));
  });

  it("honours the per-level cap", async () => {
    for (let i = 0; i < 30; i++) {
      await writeFile(path.join(workdir, "dist", `chunk${i}.js`), "//\n");
    }
    expect(await listIgnoredEntries(workdir, "dist", 5)).toHaveLength(5);
  });

  // ── Containment: `dir` is renderer-supplied ──
  it("refuses to escape the workspace", async () => {
    for (const escape of [
      "..",
      "../",
      "../../etc",
      "node_modules/../..",
      path.join(tmpdir(), "elsewhere"),
      "/etc",
    ]) {
      expect(
        await listIgnoredEntries(workdir, escape),
        `"${escape}" must not list anything`,
      ).toEqual([]);
    }
  });

  it("refuses a symlink that points outside the workspace", async () => {
    // Lexical containment passes here — only the realpath re-check catches it.
    const outside = await mkdtemp(path.join(tmpdir(), "zeros-outside-"));
    await writeFile(path.join(outside, "stolen.txt"), "secret\n");
    await symlink(outside, path.join(workdir, "node_modules", "escape"));
    expect(await listIgnoredEntries(workdir, "node_modules/escape")).toEqual([]);
    await rm(outside, { recursive: true, force: true });
  });

  // `file.ignored` is DESKTOP-ONLY: it refuses relay clients outright rather
  // than filtering their answer, because with `dir` it is a directory enumerator
  // and .gitignore was the boundary doing the work (`.conductor/` is gitignored
  // and holds sibling worktrees, which no per-name filter would flag). So
  // isSensitiveRepoPath is NOT a guard on this path.
  //
  // It still pins something this feature depends on. The Files tab now renders
  // .env / .npmrc / id_rsa* for the local operator, and `file.read` — which IS
  // remote-readable — is what a click on one of those rows calls. These assert
  // the read side stays closed for exactly the paths the tree newly reveals, and
  // that the predicate inspects EVERY segment (so a secret nested inside an
  // otherwise innocuous ignored directory is covered too).
  it("file.read's denylist still covers the paths the tree now reveals", async () => {
    for (const denied of [
      ".ssh/", // a remote client passing dir=".ssh" gets every entry filtered
      ".ssh/id_rsa",
      ".aws/",
      ".git/",
      ".env",
      ".env.local",
      ".npmrc",
      "dist/config.pem", // a secret inside an otherwise innocuous ignored dir
      "dist/service-account.json",
    ]) {
      expect(isSensitiveRepoPath(denied), `${denied} must be hidden`).toBe(true);
    }
    for (const allowed of [
      "node_modules/",
      "node_modules/.cache/",
      "dist/",
      "dist/bundle.js",
      "coverage/index.html",
      ".env.example", // a committed template, not a secret
    ]) {
      expect(isSensitiveRepoPath(allowed), `${allowed} should show`).toBe(false);
    }
  });

  it("degrades to [] rather than throwing", async () => {
    // A file browser that errors is worse than one that shows less.
    const notARepo = await mkdtemp(path.join(tmpdir(), "zeros-norepo-"));
    expect(await listIgnoredEntries(notARepo)).toEqual([]);
    expect(await listIgnoredEntries(workdir, "does/not/exist")).toEqual([]);
    expect(await listIgnoredEntries("")).toEqual([]);
    await rm(notARepo, { recursive: true, force: true });
  });
});
