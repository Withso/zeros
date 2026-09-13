import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runGit } from "../../git/git-exec";
import { commitDesignMetadata, readDesignDirectoryRegistry } from "../metadata";
import { parseDesignManifest } from "../manifest";
import {
  adoptExistingDesignDirectory,
  previewExistingDesignDirectory,
} from "../adopt-directory";

describe("explicit existing Design folder adoption", () => {
  let root: string;
  const source =
    "<!doctype html><html><head><title>Existing page</title></head><body><main>Keep this source</main></body></html>";
  beforeEach(async () => {
    root = mkdtempSync(path.join(tmpdir(), "zeros-adopt-design-"));
    process.env.ZEROS_DATA_DIR = path.join(root, "private");
    mkdirSync(path.join(root, "Brand"));
    writeFileSync(path.join(root, "Brand/home.html"), source);
    await runGit(root, ["init", "-b", "main"]);
    await runGit(root, ["config", "user.name", "Test"]);
    await runGit(root, ["config", "user.email", "test@example.com"]);
  });
  afterEach(() => {
    delete process.env.ZEROS_DATA_DIR;
    rmSync(root, { recursive: true, force: true });
  });
  const manifest = () =>
    parseDesignManifest(
      readFileSync(path.join(root, "Brand/design.toml"), "utf8"),
    )!;

  it("previews without writing and rebuilds metadata while preserving every authored file", async () => {
    const preview = await previewExistingDesignDirectory(
      root,
      path.join(root, "Brand"),
    );
    expect(preview).toMatchObject({
      directory: "Brand",
      metadataSource: "rebuild",
      frameCount: 1,
    });
    expect(existsSync(path.join(root, "Brand/design.toml"))).toBe(false);
    await adoptExistingDesignDirectory(root, "Brand", preview.revision);
    expect(manifest().document.frames).toHaveProperty("home.html");
    expect(readFileSync(path.join(root, "Brand/home.html"), "utf8")).toBe(
      source,
    );
    expect(
      readFileSync(path.join(root, ".zeros/settings.local.toml"), "utf8"),
    ).toContain(manifest().id);
    expect((await runGit(root, ["ls-files"])).stdout).toBe("");
  });

  it("preserves a manifest after .zeros deletion and repairs a stale private selection", async () => {
    commitDesignMetadata(
      root,
      "Brand",
      '{"version":3,"frames":{},"extension":{"value":null}}',
    );
    const before = manifest();
    mkdirSync(path.join(root, ".zeros"), { recursive: true });
    writeFileSync(
      path.join(root, ".zeros/settings.local.toml"),
      '[design]\ndirectory_id = "design_deleted"\n',
    );
    const preview = await previewExistingDesignDirectory(root, "Brand");
    expect(preview.metadataSource).toBe("folder");
    await adoptExistingDesignDirectory(root, "Brand", preview.revision);
    expect(manifest()).toEqual(before);
    rmSync(path.join(root, ".zeros"), { recursive: true });
    expect(readDesignDirectoryRegistry(root)?.directories[before.id].path).toBe(
      "Brand",
    );
  });

  it("restores committed metadata with the same ID and extension fields", async () => {
    commitDesignMetadata(
      root,
      "Brand",
      '{"version":3,"frames":{},"extension":{"value":null}}',
    );
    const before = manifest();
    await runGit(root, ["add", "Brand"]);
    await runGit(root, ["commit", "-m", "design"]);
    rmSync(path.join(root, "Brand/design.toml"));
    const preview = await previewExistingDesignDirectory(root, "Brand");
    expect(preview.metadataSource).toBe("git");
    await adoptExistingDesignDirectory(root, "Brand", preview.revision);
    expect(manifest()).toEqual(before);
    expect(
      (await runGit(root, ["diff", "--cached", "--name-only"])).stdout,
    ).toBe("");
  });

  it("recovers the old central metadata from Git after .zeros was removed", async () => {
    mkdirSync(path.join(root, ".zeros/design/design_old"), { recursive: true });
    writeFileSync(
      path.join(root, ".zeros/design-dir.toml"),
      'version = 1\n[directories.design_old]\npath = "Brand"\n',
    );
    writeFileSync(
      path.join(root, ".zeros/design/design_old/document.json"),
      '{"version":3,"frames":{},"custom":null}',
    );
    await runGit(root, ["add", "-f", "Brand", ".zeros"]);
    await runGit(root, ["commit", "-m", "legacy"]);
    rmSync(path.join(root, ".zeros"), { recursive: true });
    const preview = await previewExistingDesignDirectory(root, "Brand");
    expect(preview.metadataSource).toBe("git");
    await adoptExistingDesignDirectory(root, "Brand", preview.revision);
    expect(manifest()).toEqual({
      id: "design_old",
      document: { version: 3, frames: {}, custom: null },
    });
  });

  it("refuses stale previews without writing metadata", async () => {
    const preview = await previewExistingDesignDirectory(root, "Brand");
    writeFileSync(path.join(root, "Brand/extra.html"), source);
    await expect(
      adoptExistingDesignDirectory(root, "Brand", preview.revision),
    ).rejects.toThrow(/changed/);
    expect(existsSync(path.join(root, "Brand/design.toml"))).toBe(false);
  });

  it("accepts a native picker path when the registered root has a filesystem alias", async () => {
    const alias = path.join(root, "checkout-alias");
    symlinkSync(root, alias);
    await expect(
      previewExistingDesignDirectory(alias, path.join(root, "Brand")),
    ).resolves.toMatchObject({ directory: "Brand", metadataSource: "rebuild" });
  });

  it("rejects outside roots, aliases, nested repositories and unrelated manifests", async () => {
    await expect(previewExistingDesignDirectory(root, root)).rejects.toThrow(
      /inside/,
    );
    await expect(
      previewExistingDesignDirectory(root, "../outside"),
    ).rejects.toThrow(/inside/);
    symlinkSync(path.join(root, "Brand"), path.join(root, "Alias"));
    await expect(
      previewExistingDesignDirectory(root, "Alias"),
    ).rejects.toThrow();
    mkdirSync(path.join(root, "Brand/.git"));
    await expect(previewExistingDesignDirectory(root, "Brand")).rejects.toThrow(
      /nested/,
    );
    rmSync(path.join(root, "Brand/.git"), { recursive: true });
    mkdirSync(path.join(root, "Brand/nested/.git"), { recursive: true });
    await expect(previewExistingDesignDirectory(root, "Brand")).rejects.toThrow(
      /nested/,
    );
    rmSync(path.join(root, "Brand/nested"), { recursive: true });

    writeFileSync(path.join(root, "Brand/design.toml"), 'name = "unrelated"\n');
    await expect(previewExistingDesignDirectory(root, "Brand")).rejects.toThrow(
      /another application/,
    );
  });
});
