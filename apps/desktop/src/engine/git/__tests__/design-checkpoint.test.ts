import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  initializeDesignDocument,
  DESIGN_DIRECTORY_NAME,
} from "../../design/document";
import { assertDesignCommitMetadata } from "../design-checkpoint";
import { runGit } from "../git-exec";

let root: string;
let canvas: string;
const selected = [`${DESIGN_DIRECTORY_NAME}/canvas.json`];
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "zeros-design-index-"));
  await runGit(root, ["init"]);
  await initializeDesignDocument(root);
  canvas = path.join(root, ...selected[0].split("/"));
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
