import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const inputs = [
  ["interior whitespace", "assets/a.png" + " ".repeat(100_000) + "x"],
  ["unterminated comments", "/*" + "a/*".repeat(50_000)],
  ["escaped double quotes", '"' + '\\"'.repeat(50_000)],
  ["escaped single quotes", "'" + "\\'".repeat(50_000)],
  ["unclosed image functions", "image(" + "image(a".repeat(50_000)],
  ["overlapping import comments", "@import/*" + "*//*".repeat(50_000)],
  ["unescaped function names", "a".repeat(100_000) + "("],
  [
    "many literal and URL tokens",
    '/* literal */ "discarded" url(assets/a.png) '.repeat(10_000),
  ],
] as const;

interface Timing {
  method: string;
  elapsed: number;
  baseline: number;
  error: string | null;
}

// Isolate synchronous scans so a regression cannot freeze the Vitest worker.
const workerSource = `
import { parentPort, workerData } from "node:worker_threads";
import { performance } from "node:perf_hooks";
const references = await import(workerData.module);
const input = workerData.input;
const moves = { "home.html": "page-1/home.html" };
const strict = { strict: true, movedFiles: moves };
const css = ".a{background:" + input + "}";
const html = "<style>" + css + "</style><img src='assets/a.png'>";
const calls = [
  ["resolveDesignLocalReference", () => references.resolveDesignLocalReference(input, "home.html")],
  ["isContainedDesignReference", () => references.isContainedDesignReference(input, "home.html")],
  ["mayReferenceMovedDesignFrame", () => references.mayReferenceMovedDesignFrame(input, moves)],
  ["rebaseDesignReference/render", () => references.rebaseDesignReference(input, "home.html", "page-1/home.html")],
  ["rebaseDesignReference/migrate", () => references.rebaseDesignReference(input, "home.html", "page-1/home.html", strict)],
  ["rebaseDesignReference/transfer", () => references.rebaseDesignReference(input, "home.html", "page-1/home.html", { strict: true })],
  ["designCssUrlReferences/render", () => references.designCssUrlReferences(input)],
  ["designCssUrlReferences/strict", () => references.designCssUrlReferences(input, true)],
  ["designSrcsetReferences", () => references.designSrcsetReferences(input)],
  ["rebaseDesignCssReferences/render", () => references.rebaseDesignCssReferences(css, "home.html", "page-1/home.html")],
  ["rebaseDesignCssReferences/migrate", () => references.rebaseDesignCssReferences(css, "home.html", "page-1/home.html", strict)],
  ["rebaseDesignHtmlReferences/render", () => references.rebaseDesignHtmlReferences(html, "home.html", "page-1/home.html")],
  ["rebaseDesignHtmlReferences/migrate", () => references.rebaseDesignHtmlReferences(html, "home.html", "page-1/home.html", strict)],
];
function linearBaseline(value) {
  let sum = 0;
  for (let index = 0; index < value.length; index++) sum += value.charCodeAt(index);
  return sum;
}
linearBaseline("warmup".repeat(1000));
parentPort.postMessage({ ready: true });
for (const [method, call] of calls) {
  const baselineStart = performance.now();
  linearBaseline(input);
  const baseline = performance.now() - baselineStart;
  const started = performance.now();
  let error = null;
  try { call(); } catch (failure) {
    if (failure.name !== "CssSyntaxError" && !failure.message.startsWith("Cannot safely rebase")) throw failure;
    error = failure.name;
  }
  parentPort.postMessage({ method, elapsed: performance.now() - started, baseline, error });
}
parentPort.postMessage({ done: true });
`;

async function scanTimings(
  input: string,
  moduleUrl: string,
): Promise<Timing[]> {
  const worker = new Worker(
    new URL("data:text/javascript," + encodeURIComponent(workerSource)),
    {
      execArgv: [],
      workerData: {
        input,
        module: moduleUrl,
      },
    },
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise<Timing[]>((resolve, reject) => {
      const timings: Timing[] = [];
      const arm = (duration: number) => {
        clearTimeout(timer);
        timer = setTimeout(
          () =>
            reject(
              new Error(
                "Scanner stalled after " +
                  (timings.at(-1)?.method ?? "startup"),
              ),
            ),
          duration,
        );
      };
      arm(10_000);
      worker.on("error", reject);
      worker.on(
        "message",
        (message: Timing & { ready?: boolean; done?: boolean }) => {
          if (message.done) resolve(timings);
          else {
            if (!message.ready) timings.push(message);
            arm(5_000);
          }
        },
      );
    });
  } finally {
    clearTimeout(timer);
    await worker.terminate();
  }
}

describe("linear Design reference scanning", () => {
  let bundleDirectory: string | undefined;
  let moduleUrl: string;

  beforeAll(async () => {
    const result = await build({
      entryPoints: [
        fileURLToPath(new URL("../references.ts", import.meta.url)),
      ],
      bundle: true,
      format: "esm",
      platform: "node",
      write: false,
      target: "node22",
      // Bundled PostCSS uses CommonJS requires for Node builtins.
      banner: {
        js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);',
      },
    });
    bundleDirectory = await mkdtemp(
      join(tmpdir(), "zeros-reference-scanners-"),
    );
    const bundlePath = join(bundleDirectory, "references.mjs");
    await writeFile(bundlePath, result.outputFiles[0]!.text);
    moduleUrl = pathToFileURL(bundlePath).href;
  });

  afterAll(async () => {
    if (bundleDirectory)
      await rm(bundleDirectory, { recursive: true, force: true });
  });

  it.each(inputs)(
    "bounds every exported scanner/rebaser for %s",
    async (_name, input) => {
      const timings = await scanTimings(input, moduleUrl);
      expect(timings).toHaveLength(13);
      for (const timing of timings) {
        // Parser-backed rebasing has a larger constant than a character loop;
        // the relative allowance also tolerates contended/slow CI machines.
        expect(timing.elapsed, timing.method).toBeLessThan(
          Math.max(500, timing.baseline * 50),
        );
      }
    },
  );
});
