import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as storage from "../metadata-storage";
import { discoverDesignDirectories } from "../directory";
import { withDesignDirectoryNameLease } from "../directory-registry";
import {
  initializeDesignDocument,
  readDesignFrame,
  readDesignWorkspaceSnapshot,
} from "../document";
import { readCanvas } from "../document-storage";
import {
  ROOT_DESIGN_RULES,
  designPrivateStorageDirectory,
  readDirectoryDesignLayout,
  readDesignDirectoryRegistry,
  recoverWorkspaceDesignMetadata,
} from "../metadata";
import { serializeDesignRegistration } from "../manifest";
import {
  migrateDesignDirectoryPages,
  recoverDesignPagesMigration,
  readDesignPagesMigrationJournal,
  designPagesMigrationJournalName,
} from "../pages-migration";
import { runGit } from "../../git/git-exec";

describe("recoverable per-directory Design pages migration", () => {
  let root: string;
  const directory = "Product - Design";
  const read = (file: string) =>
    readFileSync(path.join(root, directory, file), "utf8");
  const write = (file: string, source: string) => {
    mkdirSync(path.dirname(path.join(root, directory, file)), {
      recursive: true,
    });
    writeFileSync(path.join(root, directory, file), source);
  };
  const seed = (pages = true) => {
    write("design.toml", serializeDesignRegistration("design_existing"));
    write(
      "canvas.json",
      JSON.stringify(
        {
          version: 1,
          id: "scene",
          title: "Product",
          extension: { keep: null },
          ...(pages
            ? {
                pages: [
                  {
                    id: "screens",
                    title: "Authored title",
                    custom: { keep: true },
                    frames: ["home", "details"],
                  },
                ],
              }
            : {}),
          frames: {
            home: {
              kind: "html",
              source: "home.html",
              title: "Home",
              x: 20,
              y: 10,
              width: 400,
              height: 800,
              z: 8,
              geometryMetadata: { keep: null },
              custom: { retained: true },
            },
            details: {
              kind: "text",
              source: "details.html",
              title: "Details",
              x: 500,
              y: 10,
              width: 400,
              height: 800,
              z: 3,
            },
          },
        },
        null,
        2,
      ) + "\n",
    );
    write(
      "home.html",
      '<!doctype html>\n<!-- href="details.html" -->\n<link href="tokens.css"><a href="details.html?q=1&amp;b=2#part">Details</a><img src="assets/a.png"><style>@import "shared.css"; .a { background:url(assets/a.png); content:"home.html" }</style>',
    );
    write(
      "details.html",
      '<!doctype html><title>Details</title><a href="home.html">Home</a>',
    );
    write("notes.html", '<!-- home.html --><a href="home.html#top">Home</a>');
    write(
      "shared.css",
      '/* home.html */ @import "details.html"; .a { background: url("home.html#icon"); content:"home.html" }\n',
    );
    write("styles/local.css", '.a { background:url("../home.html#icon") }\n');
    write(
      "components/card.html",
      '<a href="home.html">Home</a><img src="assets/a.png">',
    );
    write("assets/a.png", "asset bytes");
    write("tokens.css", ":root { --accent: blue; }\n");
    write("rules.md", ROOT_DESIGN_RULES + "\nKeep the supplied brand.\n");
  };
  const reset = () => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = mkdtempSync(path.join(tmpdir(), "zeros-design-pages-migrate-"));
    process.env.ZEROS_DATA_DIR = path.join(root, "private");
    seed();
  };
  const assertMigrated = () => {
    const layout = readDirectoryDesignLayout(root, directory)!;
    expect(layout).toMatchObject({
      kind: "meta-v3",
      manifest: { version: 3, id: "design_existing" },
    });
    const canvas = JSON.parse(read("meta/canvas.json"));
    expect(canvas.pages).toEqual([
      {
        id: "screens",
        title: "Authored title",
        custom: { keep: true },
        folder: "page-1",
        frames: ["home", "details"],
      },
    ]);
    expect(canvas).toMatchObject({
      version: 2,
      id: "scene",
      title: "Product",
      extension: { keep: null },
      frames: {
        home: {
          source: "page-1/home.html",
          z: 8,
          geometryMetadata: { keep: null },
          custom: { retained: true },
        },
        details: { source: "page-1/details.html", z: 3 },
      },
    });
    expect(read("page-1/home.html")).toContain(
      'href="details.html?q=1&amp;b=2#part"',
    );
    expect(read("page-1/home.html")).toContain('href="../tokens.css"');
    expect(read("page-1/home.html")).toContain('@import "../shared.css"');
    expect(read("page-1/home.html")).toContain('<!-- href="details.html" -->');
    expect(read("page-1/home.html")).toContain('src="../assets/a.png"');
    expect(read("page-1/details.html")).toContain('href="home.html"');
    expect(read("notes.html")).toBe(
      '<!-- home.html --><a href="page-1/home.html#top">Home</a>',
    );
    expect(read("shared.css")).toBe(
      '/* home.html */ @import "page-1/details.html"; .a { background: url("page-1/home.html#icon"); content:"home.html" }\n',
    );
    expect(read("styles/local.css")).toBe(
      '.a { background:url("../page-1/home.html#icon") }\n',
    );
    expect(read("components/card.html")).toBe(
      '<a href="page-1/home.html">Home</a><img src="assets/a.png">',
    );
    expect(read("assets/a.png")).toBe("asset bytes");
    expect(read("rules.md")).toContain("meta/canvas.json");
    expect(read("rules.md")).toContain("Keep the supplied brand.");
    for (const file of [
      "design.toml",
      "canvas.json",
      "home.html",
      "details.html",
    ])
      expect(existsSync(path.join(root, directory, file))).toBe(false);
  };
  beforeEach(reset);
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.ZEROS_DATA_DIR;
    rmSync(root, { recursive: true, force: true });
  });

  it("preserves scene identity, extensions and source while moving only registered frames", () => {
    migrateDesignDirectoryPages(root, directory);
    assertMigrated();
  });

  it("bounds full input rechecks independently of the number of predecessor deletions", () => {
    const originalRead = storage.readDesignStorageFile;
    let deleting = false;
    let guardReads = 0;
    vi.spyOn(storage, "readDesignStorageFile").mockImplementation(
      (workspace, file, ...args) => {
        if (deleting && file === directory + "/tokens.css") guardReads++;
        return originalRead(workspace, file, ...args);
      },
    );
    migrateDesignDirectoryPages(root, directory, {
      afterStep: (step) => {
        if (step === "phase:metadata") deleting = true;
        if (step === "phase:deleted") deleting = false;
      },
    });
    expect(guardReads).toBe(2);
    assertMigrated();
  });

  it.each(["predecessor", "successor"])(
    "checks the current %s before each deletion",
    (kind) => {
      expect(() =>
        migrateDesignDirectoryPages(root, directory, {
          afterStep: (step) => {
            if (step === "delete:details.html") {
              write(
                kind === "predecessor" ? "home.html" : "page-1/home.html",
                "<p>Concurrent edit</p>",
              );
            }
          },
        }),
      ).toThrow(/changed|missing/i);
      expect(existsSync(path.join(root, directory, "home.html"))).toBe(true);
      expect(
        read(kind === "predecessor" ? "home.html" : "page-1/home.html"),
      ).toBe("<p>Concurrent edit</p>");
    },
  );

  it("preserves encoded, entity and raw-space assets through migration and rendering", async () => {
    const source = `<!doctype html><html><head>
<link rel="stylesheet" href="./tokens.css?v=1#x">
<style>.image { background: url("assets/a%20b.png") }</style>
</head><body>
<img data-oid="encoded" src="assets/Hero%20Image.png">
<img data-oid="space" src="assets/Hero Image.png">
<img data-oid="entity" src="assets/r&amp;d.png">
<img data-oid="numeric" src="ass&#x65;ts/Hero%20Image.png">
<img data-oid="set" srcset="assets/Hero%20Image.png 1x, assets/a%20b.png 2x">
<div style='background: url("assets/a%20b.png")'></div>
<div style="background: url(&quot;assets/a%20b.png&quot;)"></div>
<a href="details.html">Details</a>
</body></html>`;
    write("home.html", source);
    write("assets/Hero Image.png", "hero-image");
    write("assets/a b.png", "background-image");
    write("assets/r&d.png", "entity-image");
    const assertAssets = (html: string) => {
      const images = html.match(/<img\b[^>]*>/g) ?? [];
      for (const [oid, payload] of [
        ["encoded", "hero-image"],
        ["space", "hero-image"],
        ["entity", "entity-image"],
        ["numeric", "hero-image"],
      ])
        expect(
          images.find((tag) => tag.includes(`data-oid="${oid}"`)),
        ).toContain(
          `src="data:image/png;base64,${Buffer.from(payload).toString("base64")}"`,
        );
      expect(html).toContain(
        `srcset="data:image/png;base64,${Buffer.from("hero-image").toString("base64")} 1x, data:image/png;base64,${Buffer.from("background-image").toString("base64")} 2x"`,
      );
      expect(
        html.split(Buffer.from("background-image").toString("base64")).length -
          1,
      ).toBe(4);
    };
    await withDesignDirectoryNameLease(root, directory, async () => {
      assertAssets(
        (
          await readDesignFrame(root, "home.html", undefined, {
            writeBack: false,
          })
        ).srcDoc,
      );
    });
    expect(read("home.html")).toBe(source);
    migrateDesignDirectoryPages(root, directory);
    const migrated = source
      .replace("./tokens.css?v=1#x", "../tokens.css?v=1#x")
      .replaceAll("assets/", "../assets/")
      .replace("ass&#x65;ts/", "../ass&#x65;ts/");
    expect(read("page-1/home.html")).toBe(migrated);
    await withDesignDirectoryNameLease(root, directory, async () => {
      const frame = await readDesignFrame(root, "page-1/home.html");
      assertAssets(frame.srcDoc);
      const snapshot = await readDesignWorkspaceSnapshot(root);
      expect(
        snapshot.lint.violations.filter(
          (row) => row.ruleId === "local-refs-only",
        ),
      ).toEqual([]);
    });
    expect(read("page-1/home.html")).toBe(migrated);
  });

  it("rebases decoded moved links and stationary inbound references only", () => {
    write(
      "home.html",
      '<a href="deta%69ls.html?q=1#top">Details</a><img src="assets/Hero%20Image.png">',
    );
    write(
      "notes.html",
      '<a href="h%6fme.html">Home</a><img src="assets/Hero%20Image.png">',
    );
    write(
      "components/card.html",
      '<a href="deta&#x69;ls.html">Details</a><img src="assets/Hero Image.png">',
    );
    write(
      "shared.css",
      '@import "h%6fme.html"; .a { background:url("assets/a%20b.png") }',
    );
    migrateDesignDirectoryPages(root, directory);
    expect(read("page-1/home.html")).toBe(
      '<a href="details.html?q=1#top">Details</a><img src="../assets/Hero%20Image.png">',
    );
    expect(read("notes.html")).toBe(
      '<a href="page-1/home.html">Home</a><img src="assets/Hero%20Image.png">',
    );
    expect(read("components/card.html")).toBe(
      '<a href="page-1/details.html">Details</a><img src="assets/Hero Image.png">',
    );
    expect(read("shared.css")).toBe(
      '@import "page-1/home.html"; .a { background:url("assets/a%20b.png") }',
    );
  });

  it("is an exact no-op on a completed repeat migration", () => {
    migrateDesignDirectoryPages(root, directory);
    const before = read("meta/canvas.json");
    const files = readdirSync(designPrivateStorageDirectory(root));
    expect(migrateDesignDirectoryPages(root, directory)).toEqual([]);
    expect(read("meta/canvas.json")).toBe(before);
    expect(readdirSync(designPrivateStorageDirectory(root))).toEqual(files);
  });

  it("gives an absent legacy pages array the Page 1 title", () => {
    seed(false);
    migrateDesignDirectoryPages(root, directory);
    expect(JSON.parse(read("meta/canvas.json")).pages[0]).toMatchObject({
      id: "main",
      title: "Page 1",
      folder: "page-1",
    });
  });

  it("generates a lowercase unique slug against all root entries under case folding", () => {
    write("Page-1", "unrelated file");
    mkdirSync(path.join(root, directory, "page-1-2"));
    migrateDesignDirectoryPages(root, directory);
    expect(JSON.parse(read("meta/canvas.json")).pages[0].folder).toBe(
      "page-1-3",
    );
    expect(read("Page-1")).toBe("unrelated file");
  });

  it("keeps custom rules byte-exact", () => {
    const custom = "# Brand guide\r\nCustom authored instructions.\r\n";
    write("rules.md", custom);
    migrateDesignDirectoryPages(root, directory);
    expect(read("rules.md")).toBe(custom);
  });

  it("keeps meta files and rules visible through broad root ignore patterns", async () => {
    await runGit(root, ["init", "-b", "main"]);
    writeFileSync(path.join(root, ".gitignore"), "*.json\n*.toml\n*.md\n");
    migrateDesignDirectoryPages(root, directory);
    for (const file of ["meta/design.toml", "meta/canvas.json", "rules.md"])
      await expect(
        runGit(
          root,
          [
            "check-ignore",
            "--no-index",
            "--quiet",
            "--",
            directory + "/" + file,
          ],
          { readOnly: true },
        ),
      ).rejects.toThrow();
  });

  it("keeps inspection observational, including discovery and snapshots", async () => {
    const before = read("canvas.json");
    await discoverDesignDirectories(root);
    await withDesignDirectoryNameLease(root, directory, async () => {
      await readCanvas(root);
      await readDesignWorkspaceSnapshot(root);
    });
    expect(read("canvas.json")).toBe(before);
    expect(existsSync(path.join(root, directory, "meta/design.toml"))).toBe(
      false,
    );
    expect(read("home.html")).toContain('href="tokens.css"');
  });

  it("does not touch the captured index or staged bytes when migrating dirty sources", async () => {
    await runGit(root, ["init", "-b", "main"]);
    await runGit(root, ["add", directory]);
    const index = readFileSync(path.join(root, ".git/index"));
    const staged = (
      await runGit(root, ["ls-files", "--stage", "-z"], { readOnly: true })
    ).stdout;
    write("home.html", read("home.html") + "\n<!-- unstaged draft -->\n");
    migrateDesignDirectoryPages(root, directory);
    expect(readFileSync(path.join(root, ".git/index")).equals(index)).toBe(
      true,
    );
    expect(
      (await runGit(root, ["ls-files", "--stage", "-z"], { readOnly: true }))
        .stdout,
    ).toBe(staged);
    expect(read("page-1/home.html")).toContain("unstaged draft");
    expect(
      (
        await runGit(root, ["show", ":Product - Design/home.html"], {
          readOnly: true,
        })
      ).stdout,
    ).not.toContain("unstaged draft");
  });

  it("fails preflight on ambiguous inbound references before moving any source", () => {
    write(
      "notes.html",
      '<a href="HOME.html">Home</a><img src="../outside.png">',
    );
    const before = read("home.html");
    expect(() => migrateDesignDirectoryPages(root, directory)).toThrow(
      /notes.html.*safely|safely.*notes.html/i,
    );
    expect(read("home.html")).toBe(before);
    expect(existsSync(path.join(root, directory, "meta/design.toml"))).toBe(
      false,
    );
  });

  it("does not refuse a stationary font URL outside the Design root", () => {
    const css =
      "@font-face { src: url(../../apps/web/public/fonts/Inter.woff2) }";
    write("tokens.css", css);
    migrateDesignDirectoryPages(root, directory);
    expect(read("tokens.css")).toBe(css);
    expect(readDirectoryDesignLayout(root, directory)?.kind).toBe("meta-v3");
  });

  it("keeps an unregistered root HTML's unrelated outside references unchanged", () => {
    const source =
      '<a href="../README.md">Readme</a><a href="home.html">Home</a>';
    write("notes.html", source);
    migrateDesignDirectoryPages(root, directory);
    expect(read("notes.html")).toBe(
      source.replace('href="home.html"', 'href="page-1/home.html"'),
    );
  });

  it("rebases moved outside URLs and malformed styles without weakening render containment", () => {
    const source =
      '<img src="../outside/logo.png"><style>.a { background:url(assets/a.png); broken {</style><div style="background:url(../outside/logo.png); broken {"></div>';
    write("home.html", source);
    migrateDesignDirectoryPages(root, directory);
    expect(read("page-1/home.html")).toBe(
      source
        .replace('src="../outside/', 'src="../../outside/')
        .replace("url(assets/a.png)", "url(../assets/a.png)")
        .replace("url(../outside/logo.png)", "url(../../outside/logo.png)"),
    );
  });

  it("does not let an unrelated malformed stylesheet block migration", () => {
    const source =
      ".unrelated { background:url(../../outside/logo.png); broken {";
    write("tokens.css", source);
    migrateDesignDirectoryPages(root, directory);
    expect(read("tokens.css")).toBe(source);
    expect(readDirectoryDesignLayout(root, directory)?.kind).toBe("meta-v3");
  });

  it("does not modify root ignore rules when a nested ignore fails preflight", async () => {
    await runGit(root, ["init", "-b", "main"]);
    const ignore = "*.json\n*.toml\n";
    writeFileSync(path.join(root, ".gitignore"), ignore);
    write("meta/.gitignore", "*\n");
    expect(() => migrateDesignDirectoryPages(root, directory)).toThrow(
      /ignored|gitignore/i,
    );
    expect(readFileSync(path.join(root, ".gitignore"), "utf8")).toBe(ignore);
    expect(existsSync(path.join(root, directory, "page-1/home.html"))).toBe(
      false,
    );
  });

  it.each([
    "meta-file",
    "meta-case",
    "canvas-collision",
    "manifest-collision",
    "source-symlink",
    "source-hardlink",
    "ignored-destination",
  ] as const)("fails preflight for %s", async (kind) => {
    if (kind === "meta-file") write("meta", "unrelated");
    if (kind === "meta-case") mkdirSync(path.join(root, directory, "META"));
    if (kind === "canvas-collision") write("meta/canvas.json", "unrelated");
    if (kind === "manifest-collision") write("meta/design.toml", "unrelated");
    if (kind === "source-symlink") {
      write("original.html", read("home.html"));
      rmSync(path.join(root, directory, "home.html"));
      symlinkSync("original.html", path.join(root, directory, "home.html"));
    }
    if (kind === "source-hardlink")
      linkSync(
        path.join(root, directory, "home.html"),
        path.join(root, directory, "alias.html"),
      );
    if (kind === "ignored-destination") {
      await runGit(root, ["init", "-b", "main"]);
      write("meta/.gitignore", "*\n");
    }
    const before = read("canvas.json");
    if (kind === "source-hardlink")
      expect(() => migrateDesignDirectoryPages(root, directory)).toThrow(
        /alias\.html|home\.html/,
      );
    else expect(() => migrateDesignDirectoryPages(root, directory)).toThrow();
    expect(read("canvas.json")).toBe(before);
    expect(existsSync(path.join(root, directory, "page-1/home.html"))).toBe(
      false,
    );
  });

  const payloadFiles = [
    "0-after.txt",
    "1-before.txt",
    "1-after.txt",
    "2-after.txt",
    "3-before.txt",
    "4-after.txt",
    "5-before.txt",
    "6-before.txt",
    "6-after.txt",
    "7-before.txt",
    "7-after.txt",
    "8-before.txt",
    "8-after.txt",
    "9-after.txt",
    "10-before.txt",
    "10-after.txt",
    "11-after.txt",
    "12-before.txt",
    "13-before.txt",
  ];
  // Give each durable boundary its own test budget. The discovery assertion
  // below fails if the migration adds a boundary without a recovery case.
  const crashPoints = [
    "payload-directory",
    ...payloadFiles.map((file) => "payload:" + file),
    "atomic-phase:prepared",
    "phase:prepared",
    "directory:meta",
    "directory:page-1",
    ...[
      ".gitignore",
      "components/card.html",
      "page-1/details.html",
      "page-1/home.html",
      "notes.html",
      "shared.css",
      "styles/local.css",
    ].flatMap((file) => ["atomic-source:" + file, "source:" + file]),
    "atomic-phase:sources",
    "phase:sources",
    ...["meta/canvas.json", "rules.md", "meta/design.toml"].flatMap((file) => [
      "atomic-metadata:" + file,
      "metadata:" + file,
    ]),
    "atomic-phase:metadata",
    "phase:metadata",
    ...["details.html", "home.html", "canvas.json", "design.toml"].map(
      (file) => "delete:" + file,
    ),
    "atomic-phase:deleted",
    "phase:deleted",
    "atomic-cache-generation",
    "cache-generation",
    ...["invalidated", "complete"].flatMap((phase) => [
      "atomic-phase:" + phase,
      "phase:" + phase,
    ]),
    ...[...payloadFiles].sort().map((file) => "cleanup:" + file),
    "cleanup:directory",
    "journal-removed",
  ];

  it("covers every discovered durable write/delete boundary with a recovery case", () => {
    const steps: string[] = [];
    migrateDesignDirectoryPages(root, directory, {
      afterStep: (step) => steps.push(step),
    });
    expect(steps.length).toBeGreaterThan(15);
    expect(new Set(steps).size).toBe(steps.length);
    expect(steps).toEqual(crashPoints);
  });

  it.each(crashPoints)(
    "retains small hash-only journals and recovers at %s",
    (crashPoint) => {
      expect(
        () =>
          migrateDesignDirectoryPages(root, directory, {
            afterStep: (step) => {
              if (step === crashPoint) throw new Error(`crash at ${step}`);
            },
          }),
        crashPoint,
      ).toThrow(/crash/);
      const journal = path.join(
        designPrivateStorageDirectory(root),
        designPagesMigrationJournalName(directory),
      );
      if (existsSync(journal)) {
        const bytes = readFileSync(journal, "utf8");
        expect(Buffer.byteLength(bytes), crashPoint).toBeLessThan(32 * 1024);
        expect(bytes, crashPoint).not.toContain("<!doctype");
        expect(bytes, crashPoint).not.toContain("<!--");
        expect(
          () => readDesignDirectoryRegistry(root),
          crashPoint,
        ).not.toThrow();
      }
      recoverDesignPagesMigration(root, directory);
      migrateDesignDirectoryPages(root, directory);
      assertMigrated();
      expect(existsSync(journal), crashPoint).toBe(false);
    },
  );

  it("detects edits to already-written destinations before deleting predecessors", () => {
    expect(() =>
      migrateDesignDirectoryPages(root, directory, {
        afterStep: (step) => {
          if (step === "phase:metadata") throw new Error("crash");
        },
      }),
    ).toThrow(/crash/);
    write("page-1/home.html", "<p>Concurrent edit</p>");
    expect(() => recoverDesignPagesMigration(root, directory)).toThrow(
      /changed|recovery/i,
    );
    expect(read("home.html")).toContain('href="tokens.css"');
    expect(read("page-1/home.html")).toBe("<p>Concurrent edit</p>");
  });

  it("does not replace a destination created while its atomic successor is prepared", () => {
    expect(() =>
      migrateDesignDirectoryPages(root, directory, {
        afterStep: (step) => {
          if (step === "atomic-source:page-1/home.html")
            write("page-1/home.html", "<p>Concurrent destination</p>");
        },
      }),
    ).toThrow(/changed.*migration|migration.*changed/i);
    expect(read("page-1/home.html")).toBe("<p>Concurrent destination</p>");
    expect(read("home.html")).toContain('href="tokens.css"');
  });

  it("requires every successor before removing a predecessor", () => {
    expect(() =>
      migrateDesignDirectoryPages(root, directory, {
        afterStep: (step) => {
          if (step === "phase:metadata")
            rmSync(path.join(root, directory, "page-1/home.html"));
        },
      }),
    ).toThrow(/successor.*missing|missing.*successor/i);
    expect(read("home.html")).toContain('href="tokens.css"');
    expect(read("details.html")).toContain('href="home.html"');
    recoverDesignPagesMigration(root, directory);
    assertMigrated();
  });

  it("retains recovery payloads when a successor disappears after the last predecessor deletion", () => {
    expect(() =>
      migrateDesignDirectoryPages(root, directory, {
        afterStep: (step) => {
          if (step === "delete:design.toml")
            rmSync(path.join(root, directory, "page-1/home.html"));
        },
      }),
    ).toThrow(/successor.*missing|missing.*successor/i);
    expect(
      existsSync(
        path.join(
          designPrivateStorageDirectory(root),
          designPagesMigrationJournalName(directory),
        ),
      ),
    ).toBe(true);
    recoverDesignPagesMigration(root, directory);
    assertMigrated();
  });

  it("verifies predecessor backup hashes before deleting authored files", () => {
    expect(() =>
      migrateDesignDirectoryPages(root, directory, {
        afterStep: (step) => {
          if (step === "phase:metadata") throw new Error("crash");
        },
      }),
    ).toThrow(/crash/);
    const privateRoot = designPrivateStorageDirectory(root);
    const journal = JSON.parse(
      readFileSync(
        path.join(privateRoot, designPagesMigrationJournalName(directory)),
        "utf8",
      ),
    );
    const predecessor = journal.changes.find(
      (change: { file: string }) =>
        change.file.endsWith("/home.html") && !change.file.includes("/page-1/"),
    );
    const payloadRoot = `pages-${designPagesMigrationJournalName(directory).slice(6, -5)}-${journal.token}`;
    writeFileSync(
      path.join(privateRoot, payloadRoot, predecessor.beforePayload),
      "corrupted backup",
    );
    expect(() => recoverDesignPagesMigration(root, directory)).toThrow(
      /payload.*changed|backup/i,
    );
    expect(read("home.html")).toContain('href="tokens.css"');
    expect(read("canvas.json")).toContain('"version": 1');
  });

  it("recovers journal-owned partial atomic files without retaining source temporaries", () => {
    expect(() =>
      migrateDesignDirectoryPages(root, directory, {
        afterStep: (step) => {
          if (step === "phase:prepared") throw new Error("crash");
        },
      }),
    ).toThrow(/crash/);
    const privateRoot = designPrivateStorageDirectory(root);
    const journal = JSON.parse(
      readFileSync(
        path.join(privateRoot, designPagesMigrationJournalName(directory)),
        "utf8",
      ),
    );
    mkdirSync(path.join(root, directory, "page-1"));
    const temporary = `page-1/home.html.${journal.token}.zeros-tmp`;
    write(temporary, "partial source write");
    writeFileSync(
      path.join(
        privateRoot,
        `${designPagesMigrationJournalName(directory)}.${journal.token}.zeros-tmp`,
      ),
      "partial phase write",
    );
    recoverDesignPagesMigration(root, directory);
    assertMigrated();
    expect(existsSync(path.join(root, directory, temporary))).toBe(false);
    expect(
      readdirSync(privateRoot).some((name) => name.endsWith(".zeros-tmp")),
    ).toBe(false);
  });

  it.each(["metadata", "delete"])(
    "rejects a journal that reclassifies the root ignore change as %s",
    (group) => {
      const ignore = "node_modules/\n";
      writeFileSync(path.join(root, ".gitignore"), ignore);
      expect(() =>
        migrateDesignDirectoryPages(root, directory, {
          afterStep: (step) => {
            if (step === "phase:prepared") throw new Error("crash");
          },
        }),
      ).toThrow(/crash/);
      const journalFile = path.join(
        designPrivateStorageDirectory(root),
        designPagesMigrationJournalName(directory),
      );
      const journal = JSON.parse(readFileSync(journalFile, "utf8"));
      const change = journal.changes.find(
        (entry: { file: string }) => entry.file === ".gitignore",
      );
      change.group = group;
      if (group === "delete") {
        change.after = null;
        change.afterPayload = null;
      }
      writeFileSync(journalFile, JSON.stringify(journal));
      expect(() => readDesignPagesMigrationJournal(root, directory)).toThrow(
        /Invalid Design page migration path/i,
      );
      expect(readFileSync(path.join(root, ".gitignore"), "utf8")).toBe(ignore);
      expect(read("home.html")).toContain('href="tokens.css"');
    },
  );

  it("bounds source discovery before reading a directory with too many entries", () => {
    const crowded = path.join(root, directory, "crowded");
    mkdirSync(crowded);
    for (let index = 0; index < 20_001; index++)
      writeFileSync(path.join(crowded, `${index}.txt`), "");
    expect(() => migrateDesignDirectoryPages(root, directory)).toThrow(
      /source discovery limit/i,
    );
    expect(existsSync(path.join(root, directory, "meta/design.toml"))).toBe(
      false,
    );
    expect(read("home.html")).toContain('href="tokens.css"');
  });

  it("legacy authoring upgrades all central entries to v2, then only its own directory to v3", async () => {
    rmSync(path.join(root, directory), { recursive: true });
    const other = "Other";
    for (const [id, folder] of [
      ["design_existing", directory],
      ["design_other", other],
    ]) {
      mkdirSync(path.join(root, folder), { recursive: true });
      writeFileSync(
        path.join(root, folder, "home.html"),
        "<!doctype html><title>Home</title>",
      );
      const target = path.join(root, ".zeros/design", id, "document.json");
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(
        target,
        JSON.stringify({
          version: 3,
          frames: {},
          frame_info: {},
          custom: null,
        }),
      );
    }
    writeFileSync(
      path.join(root, ".zeros/design-dir.toml"),
      `version = 1\n[directories.design_existing]\npath = "${directory}"\n[directories.design_other]\npath = "${other}"\n`,
    );
    await withDesignDirectoryNameLease(root, directory, () =>
      initializeDesignDocument(root),
    );
    expect(readDirectoryDesignLayout(root, directory)?.kind).toBe("meta-v3");
    expect(readDirectoryDesignLayout(root, other)?.kind).toBe("root-v2");
    expect(existsSync(path.join(root, other, "home.html"))).toBe(true);
    expect(existsSync(path.join(root, other, "meta/design.toml"))).toBe(false);
    expect(existsSync(path.join(root, ".zeros/design-dir.toml"))).toBe(false);
  });

  it("workspace recovery completes an admitted page migration without starting other migrations", () => {
    expect(() =>
      migrateDesignDirectoryPages(root, directory, {
        afterStep: (step) => {
          if (step === "phase:metadata") throw new Error("crash");
        },
      }),
    ).toThrow(/crash/);
    recoverWorkspaceDesignMetadata(root);
    assertMigrated();
  });
});
