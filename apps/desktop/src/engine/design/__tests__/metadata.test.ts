import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
  existsSync,
  symlinkSync,
  linkSync,
  renameSync,
  cpSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  resolveDesignDirectoryForEnter,
  discoverDesignDirectories,
} from "../directory";
import {
  commitDesignMetadata,
  designDocumentMetadataPath,
  ensureDesignMetadataLayout,
  isDesignMetadataRepoPath,
  parseDesignDirectoryRegistry,
  readDesignDirectoryRegistry,
  recoverWorkspaceDesignMetadata,
  writePrivateDesignState,
  DESIGN_DIRECTORY_REGISTRY_FILES,
} from "../metadata";
import { parseDesignManifest, serializeDesignManifest } from "../manifest";

const directory = "Product - Design";
const model = {
  version: 3,
  frames: {},
  extension: { keep: true, nullable: null },
};
const json = JSON.stringify(model);
describe("portable Design metadata", () => {
  let root: string;
  const read = (file: string) => readFileSync(path.join(root, file), "utf8");
  const write = (file: string, source: string) => {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), source);
  };
  const manifest = () => parseDesignManifest(read(`${directory}/design.toml`))!;
  const legacy = (
    registryFile = ".zeros/design-dir.toml",
    documentFile = "document.json",
  ) => {
    const registry = `version = 1\n[directories.design_existing]\npath = "${directory}"\n`;
    write(registryFile, registry);
    write(`.zeros/design/design_existing/${documentFile}`, json);
    return registry;
  };
  const journal = (
    changes: { file: string; before: string | null; after: string | null }[],
  ) =>
    writePrivateDesignState(
      root,
      `metadata-${createHash("sha256").update(directory).digest("hex").slice(0, 24)}.json`,
      JSON.stringify({
        version: 1,
        workspace: path.resolve(root),
        directory,
        changes,
      }),
    );
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "zeros-design-metadata-"));
    process.env.ZEROS_DATA_DIR = path.join(root, "private");
    mkdirSync(path.join(root, directory));
  });
  afterEach(() => {
    delete process.env.ZEROS_DATA_DIR;
    rmSync(root, { recursive: true, force: true });
  });

  it("keeps identity, complete metadata and short ownership rules with the source", () => {
    commitDesignMetadata(root, directory, json);
    expect(manifest().document).toEqual(model);
    expect(existsSync(path.join(root, ".zeros"))).toBe(false);
    const rules = read(`${directory}/rules.md`);
    expect(rules).toMatch(/Do not gitignore/);
    expect(rules).toMatch(/Code agents/);
    expect(rules).toMatch(/Zeros Settings or Design mode/);
    expect(rules.trim().split("\n").length).toBeLessThanOrEqual(8);
    const before = read(`${directory}/design.toml`);
    ensureDesignMetadataLayout(root, directory);
    expect(read(`${directory}/design.toml`)).toBe(before);
  });

  it.each(
    DESIGN_DIRECTORY_REGISTRY_FILES.flatMap((registry) =>
      ["document.json", "metadata.json"].map(
        (document) => [registry, document] as const,
      ),
    ),
  )(
    "migrates %s and %s without changing identity or document values",
    (registryFile, documentFile) => {
      legacy(registryFile, documentFile);
      expect(
        readDesignDirectoryRegistry(root)?.directories.design_existing.path,
      ).toBe(directory);
      expect(existsSync(path.join(root, directory, "design.toml"))).toBe(false);
      ensureDesignMetadataLayout(root, directory);
      expect(manifest()).toEqual({ id: "design_existing", document: model });
      expect(existsSync(path.join(root, registryFile))).toBe(false);
      expect(
        existsSync(
          path.join(root, `.zeros/design/design_existing/${documentFile}`),
        ),
      ).toBe(false);
    },
  );

  it("migrates all central documents before ignoring their former storage", () => {
    const registry = legacy();
    mkdirSync(path.join(root, "Other"));
    write(
      ".zeros/design-dir.toml",
      registry + '[directories.design_other]\npath = "Other"\n',
    );
    write(".zeros/design/design_other/metadata.json", json);
    commitDesignMetadata(root, directory, json);
    expect(parseDesignManifest(read("Other/design.toml"))).toEqual({
      id: "design_other",
      document: model,
    });
    expect(read(".gitignore")).toContain("/.zeros/");
  });

  it("finds a folder after .zeros deletion, a move, or copying it to another checkout", async () => {
    commitDesignMetadata(root, directory, json);
    const id = manifest().id;
    write(".zeros/settings.local.toml", "private = true\n");
    rmSync(path.join(root, ".zeros"), { recursive: true });
    renameSync(path.join(root, directory), path.join(root, "Moved"));
    expect(await discoverDesignDirectories(root)).toEqual(["Moved"]);
    expect(readDesignDirectoryRegistry(root)?.directories[id].path).toBe(
      "Moved",
    );
    const checkout = path.join(root, "copy");
    mkdirSync(checkout);
    cpSync(path.join(root, "Moved"), path.join(checkout, "Brand"), {
      recursive: true,
    });
    expect(await discoverDesignDirectories(checkout)).toEqual(["Brand"]);
    expect(readDesignDirectoryRegistry(checkout)?.directories[id].path).toBe(
      "Brand",
    );
  });

  it("shares discovery through a checkout's physical and alias paths", () => {
    const alias = path.join(root, "checkout-alias");
    symlinkSync(root, alias);
    expect(readDesignDirectoryRegistry(alias)).toBeNull();
    commitDesignMetadata(root, directory, json);
    const id = manifest().id;
    expect(readDesignDirectoryRegistry(alias)?.directories[id].path).toBe(
      directory,
    );
  });

  it("does not claim unrelated TOML or overwrite a conflicting manifest filename", async () => {
    write(`${directory}/design.toml`, 'name = "another application"\n');
    expect(await discoverDesignDirectories(root)).toEqual([]);
    expect(() => commitDesignMetadata(root, directory, json)).toThrow(
      /not a Zeros/,
    );
    expect(read(`${directory}/design.toml`)).toContain("another application");
  });

  it("refuses duplicate IDs, overlapping folders, competing registries and metadata", async () => {
    const registry = legacy();
    write(".zeros/design/design.toml", registry);
    expect(() => readDesignDirectoryRegistry(root)).toThrow(/Multiple/);
    rmSync(path.join(root, ".zeros/design/design.toml"));
    write(".zeros/design/design_existing/metadata.json", json);
    expect(() => ensureDesignMetadataLayout(root, directory)).toThrow(/Both/);
    rmSync(path.join(root, ".zeros/design/design_existing/metadata.json"));
    ensureDesignMetadataLayout(root, directory);
    write("Other/design.toml", read(`${directory}/design.toml`));
    await expect(discoverDesignDirectories(root)).rejects.toThrow(/same ID/);
  });

  it("ignores private .zeros without hiding designs or staging anything", () => {
    execFileSync("git", ["init", "-q"], { cwd: root });
    write(
      ".gitignore",
      "# Existing rules\nnode_modules/\n*.env\n.zeros/\n# Zeros Design metadata (managed by Zeros)\n!/.zeros/\n/.zeros/*\n!/.zeros/design/\n!/.zeros/design/**\n# End Zeros Design metadata\n",
    );
    commitDesignMetadata(root, directory, json);
    const check = (file: string) =>
      execFileSync(
        "git",
        ["check-ignore", "--no-index", "--quiet", "--", file],
        { cwd: root },
      );
    for (const file of [
      `${directory}/design.toml`,
      `${directory}/rules.md`,
      `${directory}/home.html`,
    ])
      expect(() => check(file)).toThrow();
    for (const file of [
      ".zeros/design/design.toml",
      ".zeros/settings.local.toml",
      ".zeros/acp/session.json",
      `${directory}/private.env`,
    ])
      expect(() => check(file)).not.toThrow();
    const before = read(".gitignore");
    ensureDesignMetadataLayout(root, directory);
    expect(read(".gitignore")).toBe(before);
    expect(
      execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8" }),
    ).toBe("");
  });

  it("reports ignored manifests before modifying existing metadata", () => {
    execFileSync("git", ["init", "-q"], { cwd: root });
    commitDesignMetadata(root, directory, json);
    const before = read(`${directory}/design.toml`);
    write(`${directory}/.gitignore`, "design.toml\n");
    expect(() => commitDesignMetadata(root, directory, "{}")).toThrow(/ignor/i);
    expect(read(`${directory}/design.toml`)).toBe(before);
  });

  it("finishes a previous-layout journal before migrating to per-folder metadata", async () => {
    const registry = legacy();
    write(".zeros/design/design.toml", registry);
    journal([
      { file: ".zeros/design/design.toml", before: null, after: registry },
      { file: ".zeros/design-dir.toml", before: registry, after: null },
    ]);
    await expect(
      resolveDesignDirectoryForEnter({ path: root, repoRoot: root }),
    ).resolves.toBe(directory);
    ensureDesignMetadataLayout(root, directory);
    expect(manifest().document).toEqual(model);
    expect(existsSync(path.join(root, ".zeros/design/design.toml"))).toBe(
      false,
    );
  });

  it("recovers an interrupted old document filename migration", () => {
    legacy();
    const old = ".zeros/design/design_existing/document.json";
    const next = ".zeros/design/design_existing/metadata.json";
    write(next, json);
    journal([
      { file: next, before: null, after: json },
      { file: old, before: json, after: null },
    ]);
    recoverWorkspaceDesignMetadata(root);
    ensureDesignMetadataLayout(root, directory);
    expect(manifest().document).toEqual(model);
  });

  it("keeps the deterministic legacy ID when replacing a canvas marker", () => {
    write(`${directory}/.zeros-canvas.json`, '{"version":2,"frames":{}}');
    commitDesignMetadata(root, directory, json);
    const id = manifest().id;
    expect(id).toMatch(/^design_legacy_/);
    expect(designDocumentMetadataPath(root, directory)).toBe(
      path.join(root, directory, "design.toml"),
    );
    expect(existsSync(path.join(root, directory, ".zeros-canvas.json"))).toBe(
      false,
    );
    commitDesignMetadata(root, directory, json);
    expect(manifest().id).toBe(id);
  });

  it.each([
    ".zeros/design",
    ".zeros/design/rules.md",
    ".zeros/design/future/metadata.json",
    ".zeros/design-dir.toml",
  ])("retains legacy protection for %s", (file) => {
    expect(isDesignMetadataRepoPath(file)).toBe(true);
  });
  it.each([
    'version = 1\n[directories.design_a]\npath = "../outside"',
    'version = 2\n[directories.design_a]\npath = "Design"',
    'version = 1\n[directories.bad]\npath = "Design"',
    'version = 1\n[directories.design_a]\npath = "Design"\n[directories.design_b]\npath = "design"',
    'version = 1\n[directories.design_a]\npath = "Design"\n[directories.design_b]\npath = "Design/nested"',
    'version = 1\n[directories.design_A]\npath = "First"\n[directories.design_a]\npath = "Second"',
  ])("rejects invalid registry mappings", (raw) => {
    expect(() => parseDesignDirectoryRegistry(raw)).toThrow();
  });

  it("refuses linked manifests and symlinked legacy metadata parents", () => {
    write("outside.toml", serializeDesignManifest("design_example", model));
    const target = path.join(root, directory, "design.toml");
    linkSync(path.join(root, "outside.toml"), target);
    expect(() => commitDesignMetadata(root, directory, json)).toThrow();
    rmSync(target);
    symlinkSync(path.join(root, "outside.toml"), target);
    expect(() => commitDesignMetadata(root, directory, json)).toThrow();
    rmSync(target);
    mkdirSync(path.join(root, ".zeros"));
    symlinkSync(path.join(root, directory), path.join(root, ".zeros/design"));
    expect(() => commitDesignMetadata(root, directory, json)).toThrow();
  });

  it("does not overwrite source edits racing a metadata transaction", () => {
    write(`${directory}/frame.html`, "external edit");
    expect(() =>
      commitDesignMetadata(root, directory, json, [
        { file: `${directory}/frame.html`, before: "old", after: "migrated" },
      ]),
    ).toThrow(/changed/);
    expect(read(`${directory}/frame.html`)).toBe("external edit");
    expect(existsSync(path.join(root, directory, "design.toml"))).toBe(false);
  });

  it("replays an interrupted metadata/source pair and retains recovery on a competing edit", () => {
    commitDesignMetadata(root, directory, json);
    const file = `${directory}/design.toml`;
    const before = read(file),
      after = serializeDesignManifest(manifest().id, {
        ...model,
        extension: {},
      });
    const frame = `${directory}/frame.html`;
    write(frame, "old source");
    const record = journal([
      { file, before, after },
      { file: frame, before: "old source", after: "new source" },
    ]);
    write(file, after);
    write(frame, "competing source");
    expect(() => recoverWorkspaceDesignMetadata(root)).toThrow(/changed/);
    expect(existsSync(record)).toBe(true);
    write(frame, "old source");
    recoverWorkspaceDesignMetadata(root);
    expect(read(frame)).toBe("new source");
    expect(existsSync(record)).toBe(false);
  });

  it("checks the exact manifest bytes captured before an asynchronous edit", () => {
    commitDesignMetadata(root, directory, json);
    const file = `${directory}/design.toml`;
    const expected = { file, source: read(file), registry: null };
    write(file, "external edit");
    expect(() =>
      commitDesignMetadata(root, directory, json, [], expected),
    ).toThrow(/changed/);
    expect(read(file)).toBe("external edit");
  });
});
