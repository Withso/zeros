import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { serializeDesignRegistration } from "../../design/manifest";
import { runGit } from "../git-exec";
import { assertReviewSourceWriteAllowed } from "../review-source-guard";
import { designDirectoriesAtRef, prepareDesignSafeIntegration, semanticDesignDirectories } from "../design-draft-guard";

describe("Git guards for Design pages", () => {
  let root: string;
  const directory = "Screens";
  const frame = "Screens/Checkout/home.html";
  const git = (args: string[]) => runGit(root, args, { readOnly: true });
  beforeEach(async () => {
    root = mkdtempSync(path.join(tmpdir(), "zeros-design-pages-guards-"));
    process.env.ZEROS_DATA_DIR = path.join(root, ".private");
    await git(["init", "-b", "main"]);
    await git(["config", "user.name", "Test"]);
    await git(["config", "user.email", "test@example.com"]);
    mkdirSync(path.join(root, directory, "meta"), { recursive: true });
    mkdirSync(path.join(root, directory, "Checkout"));
    writeFileSync(path.join(root, ".gitignore"), ".private/\n");
    writeFileSync(path.join(root, directory, "meta/design.toml"), serializeDesignRegistration("design_pages", 3));
    writeFileSync(path.join(root, directory, "meta/canvas.json"), JSON.stringify({
      version: 2, id: "scene", title: "Screens",
      pages: [{ id: "checkout", title: "Checkout", folder: "Checkout", frames: ["home"] }],
      frames: { home: { kind: "html", source: "Checkout/home.html", title: "Home", x: 0, y: 0, width: 800, height: 600 } },
    }));
    writeFileSync(path.join(root, directory, "rules.md"), "Custom guidance\n");
    writeFileSync(path.join(root, frame), "<main>Original</main>");
    writeFileSync(path.join(root, "code.txt"), "Original code\n");
    await git(["add", "."]);
    await git(["commit", "-m", "fixture"]);
  });
  afterEach(() => {
    delete process.env.ZEROS_DATA_DIR;
    rmSync(root, { recursive: true, force: true });
  });

  it.each(["working tree", "index", "HEAD"])("protects the Design root using %s registration evidence", async (evidence) => {
    if (evidence !== "working tree") rmSync(path.join(root, directory, "meta/design.toml"));
    if (evidence === "HEAD") execFileSync("git", ["rm", "--cached", `${directory}/meta/design.toml`], { cwd: root, stdio: "pipe" });
    const index = readFileSync(path.join(root, ".git/index"));
    for (const file of [frame, `${directory}/rules.md`, `${directory}/tokens.css`, `${directory}/meta/canvas.json`])
      await expect(assertReviewSourceWriteAllowed(root, file)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    const roots = await semanticDesignDirectories({ workspaceId: "workspace", path: root, repoRoot: root });
    expect(roots).toContain(directory);
    expect(roots).not.toContain(`${directory}/meta`);
    expect(readFileSync(path.join(root, ".git/index"))).toEqual(index);
  });

  it("protects incoming meta registrations while allowing unrelated application TOML", async () => {
    const roots = await designDirectoriesAtRef(root, "HEAD");
    expect(roots).toContain(directory);
    expect(roots).not.toContain(`${directory}/meta`);
    await expect(assertReviewSourceWriteAllowed(root, "New/meta/design.toml", serializeDesignRegistration("design_new", 3)))
      .rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(assertReviewSourceWriteAllowed(root, "Application/meta/design.toml", 'name = "app"\n')).resolves.toBeUndefined();
    await expect(assertReviewSourceWriteAllowed(root, "code.txt")).resolves.toBeUndefined();
  });

  it.each([true, false])("checks incoming Design territory with a dirty paged source (Design impact: %s)", async (designImpact) => {
    const base = (await git(["rev-parse", "HEAD"])).stdout.trim();
    const changed = designImpact ? frame : "code.txt";
    writeFileSync(path.join(root, changed), "Committed successor\n");
    await git(["add", changed]);
    await git(["commit", "-m", "successor"]);
    writeFileSync(path.join(root, frame), "<main>Live draft</main>");
    const index = readFileSync(path.join(root, ".git/index"));
    const request = prepareDesignSafeIntegration({
      workspaceId: "workspace", path: root, repoRoot: root,
      target: base, operation: "Checkout", comparison: "tree-transition",
    });
    if (designImpact) await expect(request).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    else await expect(request).resolves.toBe(base);
    expect(readFileSync(path.join(root, frame), "utf8")).toBe("<main>Live draft</main>");
    expect(readFileSync(path.join(root, ".git/index"))).toEqual(index);
  });
});
