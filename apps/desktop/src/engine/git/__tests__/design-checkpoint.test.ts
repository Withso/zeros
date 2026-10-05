import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, expect, it } from "vitest";
import { DESIGN_DIRECTORY_NAME } from "../../design/document";
import { serializeDesignRegistration } from "../../design/manifest";
import { assertDesignCommitMetadata } from "../design-checkpoint";
import { runGit } from "../git-exec";

let root: string;
let canvas: string;
const selected = [`${DESIGN_DIRECTORY_NAME}/canvas.json`];
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "zeros-design-index-"));
  await runGit(root, ["init"]);
  await mkdir(path.join(root, DESIGN_DIRECTORY_NAME));
  await writeFile(path.join(root, DESIGN_DIRECTORY_NAME, "design.toml"), serializeDesignRegistration("design_test"));
  await writeFile(path.join(root, DESIGN_DIRECTORY_NAME, "rules.md"), "Fixture instructions");
  canvas = path.join(root, ...selected[0].split("/"));
  await writeFile(canvas, '{"version":1,"frames":{}}');
  await runGit(root, ["add", DESIGN_DIRECTORY_NAME]);
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

it("requires the staged canvas companion to a v2 registration", async () => {
  await runGit(root, ["update-index", "--force-remove", "--", selected[0]]);
  await expect(assertDesignCommitMetadata(root, {}, selected)).rejects.toThrow(
    /canvas.json/,
  );
});
it("validates staged canvas bytes, without substituting a later unstaged fix", async () => {
  await writeFile(canvas, "{ broken");
  await runGit(root, ["add", selected[0]]);
  await writeFile(canvas, '{"version":1,"frames":{}}');
  await expect(assertDesignCommitMetadata(root, {}, selected)).rejects.toThrow(
    /canvas/i,
  );
  await runGit(root, ["add", selected[0]]);
  await expect(
    assertDesignCommitMetadata(root, {}, selected),
  ).resolves.toBeUndefined();
});
it("requires registered frame sources in the same captured index", async () => {
  await writeFile(
    canvas,
    JSON.stringify({
      version: 1,
      frames: {
        home: {
          kind: "html",
          source: "home.html",
          title: "Home",
          x: 0,
          y: 0,
          width: 800,
          height: 600,
        },
      },
    }),
  );
  await runGit(root, ["add", selected[0]]);
  await expect(assertDesignCommitMetadata(root, {}, selected)).rejects.toThrow(
    /home.html/,
  );
  await writeFile(
    path.join(root, DESIGN_DIRECTORY_NAME, "home.html"),
    "<!doctype html><p>Home</p>",
  );
  await runGit(root, ["add", DESIGN_DIRECTORY_NAME]);
  await expect(
    assertDesignCommitMetadata(root, {}, selected),
  ).resolves.toBeUndefined();
});

async function stagePages() {
  await rm(path.join(root, DESIGN_DIRECTORY_NAME, "design.toml"));
  await rm(canvas);
  await mkdir(path.join(root, DESIGN_DIRECTORY_NAME, "meta"));
  await writeFile(path.join(root, DESIGN_DIRECTORY_NAME, "meta/design.toml"), serializeDesignRegistration("design_test", 3));
  const document = {
    version: 2,
    pages: [
      { id: "first", title: "First", folder: "Checkout", frames: ["a"] },
      { id: "second", title: "Second", folder: "login_page", frames: ["b"] },
    ],
    frames: Object.fromEntries(["Checkout", "login_page"].map((folder, index) => [index ? "b" : "a", {
      kind: "html", source: folder + "/home.html", title: "Home", x: 0, y: 0, width: 800, height: 600,
    }])),
  };
  await writeFile(path.join(root, DESIGN_DIRECTORY_NAME, "meta/canvas.json"), JSON.stringify(document));
  for (const folder of ["Checkout", "login_page"]) {
    await mkdir(path.join(root, DESIGN_DIRECTORY_NAME, folder));
    await writeFile(path.join(root, DESIGN_DIRECTORY_NAME, folder, "home.html"), "<!doctype html><p>Home</p>");
  }
  await runGit(root, ["add", "-A", DESIGN_DIRECTORY_NAME]);
  return document;
}

it("validates v3 from the captured index, with rules at the Design root and nested frame sources", async () => {
  await stagePages();
  await expect(assertDesignCommitMetadata(root, {}, [`${DESIGN_DIRECTORY_NAME}/Checkout/home.html`])).resolves.toBeUndefined();
});

it("requires the v3 meta canvas companion even when only a page frame is selected", async () => {
  await stagePages();
  await runGit(root, ["update-index", "--force-remove", "--", `${DESIGN_DIRECTORY_NAME}/meta/canvas.json`]);
  await expect(assertDesignCommitMetadata(root, {}, [`${DESIGN_DIRECTORY_NAME}/Checkout/home.html`])).rejects.toThrow(/meta\/canvas.json/);
});

it("never substitutes working-tree v3 metadata or frame sources for the captured index", async () => {
  const document = await stagePages();
  const file = `${DESIGN_DIRECTORY_NAME}/meta/canvas.json`;
  await writeFile(path.join(root, file), "{broken");
  await runGit(root, ["add", file]);
  await writeFile(path.join(root, file), JSON.stringify(document));
  await expect(assertDesignCommitMetadata(root, {}, [file])).rejects.toThrow(/staged.*canvas/i);
  await runGit(root, ["add", file]);
  await runGit(root, ["update-index", "--force-remove", "--", `${DESIGN_DIRECTORY_NAME}/login_page/home.html`]);
  await expect(assertDesignCommitMetadata(root, {}, [file])).rejects.toThrow(/login_page\/home.html/);
});

it("rejects competing staged root and meta registrations", async () => {
  await stagePages();
  await writeFile(path.join(root, DESIGN_DIRECTORY_NAME, "design.toml"), serializeDesignRegistration("design_test"));
  await runGit(root, ["add", DESIGN_DIRECTORY_NAME]);
  await expect(assertDesignCommitMetadata(root, {}, [`${DESIGN_DIRECTORY_NAME}/Checkout/home.html`])).rejects.toThrow(/competing/i);
});

it("does not accept rules beside the v3 manifest instead of at the Design root", async () => {
  await stagePages();
  await rm(path.join(root, DESIGN_DIRECTORY_NAME, "rules.md"));
  await writeFile(path.join(root, DESIGN_DIRECTORY_NAME, "meta/rules.md"), "Wrong location");
  await runGit(root, ["add", "-A", DESIGN_DIRECTORY_NAME]);
  await expect(assertDesignCommitMetadata(root, {}, [`${DESIGN_DIRECTORY_NAME}/Checkout/home.html`])).rejects.toThrow(/rules.md/);
});
