import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { listWorkspaceFilesWithDesign } from "../file-listing";
import { serializeDesignRegistration } from "../manifest";
import { runGit } from "../../git/git-exec";

let root: string;
beforeEach(async () => {
  root = mkdtempSync(path.join(tmpdir(), "zeros-design-pages-listing-"));
  process.env.ZEROS_DATA_DIR = path.join(root, ".private");
  await runGit(root, ["init", "-b", "main"]);
});
afterEach(() => {
  delete process.env.ZEROS_DATA_DIR;
  rmSync(root, { recursive: true, force: true });
});

it("lists meta metadata, root guidance and nested page source under the registered Design root", async () => {
  const source = {
    "Screens/meta/design.toml": serializeDesignRegistration("design_pages", 3),
    "Screens/meta/canvas.json": JSON.stringify({
      version: 2,
      pages: [{ id: "page", title: "Page 1", folder: "page-1", frames: [] }],
      frames: {},
    }),
    "Screens/rules.md": "Keep custom guidance",
    "Screens/tokens.css": ":root {}",
    "Screens/page-1/home.html": "<main>Home</main>",
    "Screens/assets/icon.svg": "<svg></svg>",
    "Screens/components/header.html": "<header>Header</header>",
    "Application/meta/design.toml": 'name = "app"\n',
  };
  for (const [file, contents] of Object.entries(source)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), contents);
  }
  await runGit(root, ["add", "."]);
  const listing = await listWorkspaceFilesWithDesign(root);
  expect(listing.designDirectories).toEqual(["Screens"]);
  expect(listing.files).toEqual(expect.arrayContaining(Object.keys(source)));
  expect(existsSync(path.join(root, "Screens/design.toml"))).toBe(false);
  expect(existsSync(path.join(root, "Screens/canvas.json"))).toBe(false);
});

it("retains the Design root in Files while the staged meta manifest is removed from the worktree", async () => {
  mkdirSync(path.join(root, "Screens/meta"), { recursive: true });
  writeFileSync(
    path.join(root, "Screens/meta/design.toml"),
    serializeDesignRegistration("design_pages", 3),
  );
  await runGit(root, ["add", "Screens/meta/design.toml"]);
  rmSync(path.join(root, "Screens/meta/design.toml"));
  const listing = await listWorkspaceFilesWithDesign(root);
  expect(listing.designDirectories).toEqual(["Screens"]);
  // Files lists existing source; Git views own the deleted path. Recognition
  // still protects/groups the root using the captured index registration.
  expect(listing.files).not.toContain("Screens/meta/design.toml");
});
