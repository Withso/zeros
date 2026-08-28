import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  DESIGN_WATCH_IGNORE_FILENAME,
  DESIGN_WATCH_ROOTS_FILENAME,
  designWatchIgnoreSource,
  designWatchIsolationEnvironment,
  nodeDesignWatchGuardSource,
  nodeOptionsWithDesignWatchGuard,
  prepareReusableDesignWatchIsolation,
  shouldSuppressDesignWatchEvent,
} from "../design-watch-isolation";

const execFileAsync = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("repository-task Design watcher isolation", () => {
  it("filters nested Design events without hiding code events or ambiguous parent events", () => {
    const workspace = path.join("/tmp", "project");
    const design = path.join(workspace, "Zeros Design");

    expect(
      shouldSuppressDesignWatchEvent(
        workspace,
        path.join("Zeros Design", "frame-1.html"),
        [design],
      ),
    ).toBe(true);
    expect(
      shouldSuppressDesignWatchEvent(workspace, "src/app.ts", [design]),
    ).toBe(false);
    expect(shouldSuppressDesignWatchEvent(design, null, [design])).toBe(true);
    expect(shouldSuppressDesignWatchEvent(workspace, null, [design])).toBe(
      false,
    );
    expect(
      shouldSuppressDesignWatchEvent(workspace, "Zeros Designer/frame.ts", [
        design,
      ]),
    ).toBe(false);
  });

  it("canonicalizes a missing event leaf through the nearest existing symlink ancestor", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "zeros-watch-alias-"));
    roots.push(root);
    const workspace = path.join(root, "workspace");
    const alias = path.join(root, "workspace-alias");
    const design = path.join(workspace, "Zeros Design");
    await mkdir(design, { recursive: true });
    await symlink(workspace, alias, "dir");

    expect(
      shouldSuppressDesignWatchEvent(
        root,
        path.join(alias, "Zeros Design", "not-created-yet.html"),
        [design],
      ),
    ).toBe(true);
  });

  it("renders exact workspace-relative native watcher ignores without broad basename matches", () => {
    const workspace = path.join("/tmp", "project");
    const sibling = path.join("/tmp", "sibling");

    expect(
      designWatchIgnoreSource(
        [
          path.join(workspace, "Zeros Design"),
          path.join(workspace, "apps", "web", "Design [draft]?"),
          path.join(sibling, "Zeros Design"),
        ],
        [workspace],
      ),
    ).toBe(
      [
        "/Zeros\\ Design",
        "/Zeros\\ Design/**",
        "/apps/web/Design\\ \\[draft\\]\\?",
        "/apps/web/Design\\ \\[draft\\]\\?/**",
        "",
      ].join("\n"),
    );
  });

  it("shares complete integrity-checked artifacts across concurrent terminal starts", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "zeros-shared-watch-"));
    roots.push(root);
    const design = path.join(root, "Zeros Design");
    await mkdir(design, { recursive: true });

    const [first, second] = await Promise.all([
      prepareReusableDesignWatchIsolation(
        path.join(root, "guards"),
        [design],
        [root],
      ),
      prepareReusableDesignWatchIsolation(
        path.join(root, "guards"),
        [design],
        [root],
      ),
    ]);

    expect(first).toStrictEqual(second);
    expect(path.basename(first!.ignoreFilePath)).toBe(
      DESIGN_WATCH_IGNORE_FILENAME,
    );
    expect(path.basename(first!.rootsFilePath)).toBe(
      DESIGN_WATCH_ROOTS_FILENAME,
    );
    await expect(readFile(first!.ignoreFilePath, "utf8")).resolves.toBe(
      "/Zeros\\ Design\n/Zeros\\ Design/**\n",
    );
    const canonicalDesign = await realpath(design);
    await expect(readFile(first!.rootsFilePath, "utf8")).resolves.toBe(
      `${JSON.stringify({ version: 1, protectedRoots: [canonicalDesign] })}\n`,
    );
  });

  it("composes Node, Watchexec, and generic watcher environments without dropping user options", () => {
    const artifactRoot = path.join("/tmp", "watch artifacts with spaces");
    const artifacts = {
      nodeGuardPath: path.join(artifactRoot, "guard.cjs"),
      ignoreFilePath: path.join(artifactRoot, DESIGN_WATCH_IGNORE_FILENAME),
      rootsFilePath: path.join(artifactRoot, DESIGN_WATCH_ROOTS_FILENAME),
    };

    const composed = designWatchIsolationEnvironment(
      {
        NODE_OPTIONS: "--trace-warnings",
        WATCHEXEC_IGNORE_FILES: "/user/one.ignore:/user/two.ignore",
      },
      artifacts,
    );
    expect(composed).toEqual({
      NODE_OPTIONS: `--trace-warnings --require "${artifacts.nodeGuardPath}"`,
      WATCHEXEC_IGNORE_FILES: [
        "/user/one.ignore",
        "/user/two.ignore",
        artifacts.ignoreFilePath,
      ].join(path.delimiter),
      ZEROS_DESIGN_WATCH_IGNORE_FILE: artifacts.ignoreFilePath,
      ZEROS_DESIGN_WATCH_ROOTS_FILE: artifacts.rootsFilePath,
    });
    expect(designWatchIsolationEnvironment(composed, artifacts)).toEqual(
      composed,
    );
  });

  it("does not inject global Bun arguments that can corrupt subcommand dispatch", () => {
    const patch = designWatchIsolationEnvironment(
      { BUN_OPTIONS: "--smol" },
      {
        nodeGuardPath: "/tmp/guard.cjs",
        ignoreFilePath: "/tmp/watch.ignore",
        rootsFilePath: "/tmp/watch-roots.json",
      },
    );

    expect(patch).not.toHaveProperty("BUN_OPTIONS");
  });

  it("syncs the guard into ESM fs exports and suppresses only Design watcher callbacks", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "zeros-watch-guard-"));
    roots.push(root);
    const workspace = path.join(root, "workspace with spaces");
    const design = path.join(workspace, "Zeros Design");
    const code = path.join(workspace, "src");
    await Promise.all([
      mkdir(design, { recursive: true }),
      mkdir(code, { recursive: true }),
    ]);
    const guard = path.join(root, "watch guard.cjs");
    await writeFile(guard, nodeDesignWatchGuardSource([design]), "utf8");

    const script = String.raw`
import { watch, writeFileSync } from "node:fs";
import path from "node:path";
const [design, code] = process.argv.slice(1);
const seen = [];
const watchers = [
  watch(design, (_event, file) => seen.push("design:" + String(file))),
  watch(code, (_event, file) => seen.push("code:" + String(file))),
];
setTimeout(() => {
  writeFileSync(path.join(design, "frame.html"), "design");
  writeFileSync(path.join(code, "app.ts"), "code");
}, 30);
setTimeout(() => {
  for (const watcher of watchers) watcher.close();
  process.stdout.write(JSON.stringify(seen));
}, 250);
`;
    const { stdout } = await execFileAsync(
      process.execPath,
      ["--input-type=module", "-e", script, design, code],
      {
        env: {
          ...process.env,
          NODE_OPTIONS: nodeOptionsWithDesignWatchGuard(
            process.env.NODE_OPTIONS,
            guard,
          ),
        },
      },
    );
    const seen = JSON.parse(stdout) as string[];
    expect(seen.some((event) => event.startsWith("code:"))).toBe(true);
    expect(seen.some((event) => event.startsWith("design:"))).toBe(false);
  });

  it("filters the native macOS fsevents backend used by Vite and chokidar", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "zeros-fsevents-guard-"));
    roots.push(root);
    const workspace = path.join(root, "workspace");
    const design = path.join(workspace, "Zeros Design");
    const code = path.join(workspace, "src");
    const fakeFsevents = path.join(root, "node_modules", "fsevents");
    await Promise.all([
      mkdir(design, { recursive: true }),
      mkdir(code, { recursive: true }),
      mkdir(fakeFsevents, { recursive: true }),
    ]);
    await writeFile(
      path.join(fakeFsevents, "index.js"),
      `let listener;
module.exports = {
  watch(_root, callback) { listener = callback; return () => {}; },
  emit(file) { listener(file, 0); },
  getInfo(file) { return { path: file, event: "modified", type: "file", changes: {} }; },
};
`,
      "utf8",
    );
    const guard = path.join(root, "guard.cjs");
    await writeFile(guard, nodeDesignWatchGuardSource([design]), "utf8");

    const script = String.raw`
const fsevents = require("fsevents");
const [designFile, codeFile] = process.argv.slice(1);
const seen = [];
fsevents.watch(process.cwd(), (file) => seen.push(file));
fsevents.emit(designFile);
fsevents.emit(codeFile);
process.stdout.write(JSON.stringify(seen));
`;
    const { stdout } = await execFileAsync(
      process.execPath,
      [
        "-e",
        script,
        path.join(design, "frame.html"),
        path.join(code, "app.ts"),
      ],
      {
        cwd: root,
        env: {
          ...process.env,
          NODE_OPTIONS: nodeOptionsWithDesignWatchGuard(
            process.env.NODE_OPTIONS,
            guard,
          ),
        },
      },
    );
    expect(JSON.parse(stdout)).toEqual([path.join(code, "app.ts")]);
  });

  it("discovers a renamed marker-backed Design root in a long-lived watcher", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "zeros-fsevents-rename-"));
    roots.push(root);
    const workspace = path.join(root, "workspace");
    const originalDesign = path.join(workspace, "Zeros Design");
    const renamedDesign = path.join(workspace, "Product Canvas");
    const code = path.join(workspace, "src");
    const fakeFsevents = path.join(root, "node_modules", "fsevents");
    await Promise.all([
      mkdir(originalDesign, { recursive: true }),
      mkdir(code, { recursive: true }),
      mkdir(fakeFsevents, { recursive: true }),
    ]);
    await writeFile(
      path.join(originalDesign, ".zeros-canvas.json"),
      "{}\n",
      "utf8",
    );
    const guard = path.join(root, "guard.cjs");
    await writeFile(
      guard,
      nodeDesignWatchGuardSource([originalDesign], [workspace]),
      "utf8",
    );
    await writeFile(
      path.join(fakeFsevents, "index.js"),
      `let listener;
module.exports = {
  watch(_root, callback) { listener = callback; return () => {}; },
  emit(file) { listener(file, 0); },
};
`,
      "utf8",
    );

    const script = String.raw`
const fsevents = require("fsevents");
const fs = require("node:fs");
const [originalDesign, renamedDesign, designFile, oldPathCodeFile, codeFile] = process.argv.slice(1);
const seen = [];
fsevents.watch(process.cwd(), (file) => seen.push(file));
fs.renameSync(originalDesign, renamedDesign);
fsevents.emit(designFile);
fs.mkdirSync(originalDesign, { recursive: true });
fsevents.emit(oldPathCodeFile);
fsevents.emit(codeFile);
process.stdout.write(JSON.stringify(seen));
`;
    const designFile = path.join(renamedDesign, "frame.html");
    const oldPathCodeFile = path.join(originalDesign, "now-code.ts");
    const codeFile = path.join(code, "app.ts");
    const { stdout } = await execFileAsync(
      process.execPath,
      [
        "-e",
        script,
        originalDesign,
        renamedDesign,
        designFile,
        oldPathCodeFile,
        codeFile,
      ],
      {
        cwd: root,
        env: {
          ...process.env,
          NODE_OPTIONS: nodeOptionsWithDesignWatchGuard(
            process.env.NODE_OPTIONS,
            guard,
          ),
        },
      },
    );
    expect(JSON.parse(stdout)).toEqual([oldPathCodeFile, codeFile]);
  });

  it.runIf(process.platform === "darwin")(
    "suppresses real macOS fsevents notifications from Design territory",
    async () => {
      const root = await mkdtemp(path.join(tmpdir(), "zeros-real-fsevents-"));
      roots.push(root);
      const design = path.join(root, "Zeros Design");
      const code = path.join(root, "src");
      await Promise.all([
        mkdir(design, { recursive: true }),
        mkdir(code, { recursive: true }),
      ]);
      const guard = path.join(root, "guard.cjs");
      await writeFile(guard, nodeDesignWatchGuardSource([design]), "utf8");

      const script = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const fsevents = require("fsevents");
const [root, design, code] = process.argv.slice(1);
const seen = [];
const stop = fsevents.watch(root, (file) => seen.push(file));
setTimeout(() => {
  fs.writeFileSync(path.join(design, "frame.html"), "design");
  fs.writeFileSync(path.join(code, "app.ts"), "code");
}, 100);
setTimeout(async () => {
  await stop();
  process.stdout.write(JSON.stringify(seen));
}, 1000);
`;
      const { stdout } = await execFileAsync(
        process.execPath,
        ["-e", script, root, design, code],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            NODE_OPTIONS: nodeOptionsWithDesignWatchGuard(
              process.env.NODE_OPTIONS,
              guard,
            ),
          },
        },
      );
      const seen = JSON.parse(stdout) as string[];
      const canonicalSeen = await Promise.all(
        seen.map((file) => realpath(file)),
      );
      const [canonicalDesign, canonicalCode] = await Promise.all([
        realpath(design),
        realpath(code),
      ]);
      expect(
        canonicalSeen.some((file) =>
          file.startsWith(canonicalDesign + path.sep),
        ),
      ).toBe(false);
      expect(
        canonicalSeen.some((file) => file.startsWith(canonicalCode + path.sep)),
      ).toBe(true);
    },
  );

  it("suppresses fs.watchFile callbacks for Design files without hiding code", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "zeros-watch-file-"));
    roots.push(root);
    const designFile = path.join(root, "Zeros Design", "frame.html");
    const codeFile = path.join(root, "src", "app.ts");
    await Promise.all([
      mkdir(path.dirname(designFile), { recursive: true }),
      mkdir(path.dirname(codeFile), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(designFile, "before", "utf8"),
      writeFile(codeFile, "before", "utf8"),
    ]);
    const guard = path.join(root, "guard.cjs");
    await writeFile(
      guard,
      nodeDesignWatchGuardSource([path.dirname(designFile)]),
      "utf8",
    );

    const script = String.raw`
const fs = require("node:fs");
const [designFile, codeFile] = process.argv.slice(1);
const seen = [];
const onDesign = () => seen.push("design");
const onCode = () => seen.push("code");
fs.watchFile(designFile, { interval: 20 }, onDesign);
fs.watchFile(codeFile, { interval: 20 }, onCode);
setTimeout(() => {
  fs.writeFileSync(designFile, "after");
  fs.writeFileSync(codeFile, "after");
}, 40);
setTimeout(() => {
  fs.unwatchFile(designFile, onDesign);
  fs.unwatchFile(codeFile, onCode);
  process.stdout.write(JSON.stringify(seen));
}, 250);
`;
    const { stdout } = await execFileAsync(
      process.execPath,
      ["-e", script, designFile, codeFile],
      {
        env: {
          ...process.env,
          NODE_OPTIONS: nodeOptionsWithDesignWatchGuard(
            process.env.NODE_OPTIONS,
            guard,
          ),
        },
      },
    );
    expect(JSON.parse(stdout)).toContain("code");
    expect(JSON.parse(stdout)).not.toContain("design");
  });

  it("filters fs.promises.watch async iterators without swallowing code events", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "zeros-promises-watch-"));
    roots.push(root);
    const design = path.join(root, "Zeros Design");
    const code = path.join(root, "src");
    await Promise.all([
      mkdir(design, { recursive: true }),
      mkdir(code, { recursive: true }),
    ]);
    const guard = path.join(root, "guard.cjs");
    await writeFile(guard, nodeDesignWatchGuardSource([design]), "utf8");

    const script = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const [design, code] = process.argv.slice(1);
const controller = new AbortController();
const designEvents = fs.promises.watch(design, { signal: controller.signal });
const codeEvents = fs.promises.watch(code, { signal: controller.signal });
const designNext = designEvents.next().then(
  () => "design",
  (error) => error && error.name === "AbortError" ? "aborted" : "error",
);
setTimeout(() => {
  fs.writeFileSync(path.join(design, "frame.html"), "design");
  fs.writeFileSync(path.join(code, "app.ts"), "code");
}, 30);
(async () => {
  const codeEvent = await Promise.race([
    codeEvents.next(),
    new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error("code event timeout")), 1000);
      timer.unref();
    }),
  ]);
  setTimeout(() => controller.abort(), 80);
  const designResult = await designNext;
  process.stdout.write(JSON.stringify({ codeEvent, designResult }));
})().catch((error) => {
  process.stderr.write(String(error));
  process.exitCode = 1;
});
`;
    const { stdout } = await execFileAsync(
      process.execPath,
      ["-e", script, design, code],
      {
        env: {
          ...process.env,
          NODE_OPTIONS: nodeOptionsWithDesignWatchGuard(
            process.env.NODE_OPTIONS,
            guard,
          ),
        },
      },
    );
    expect(JSON.parse(stdout)).toMatchObject({
      codeEvent: { done: false, value: { filename: "app.ts" } },
      designResult: "aborted",
    });
  });
});
