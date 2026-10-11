import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const probe = fileURLToPath(new URL("../cloud-workspace-validation/runtime-base-v4/stock-prerequisites.py", import.meta.url));

// Load the probe's own tables; the base never installs packages, so the
// stock probe and the runtime asset inventory are the dependency contract.
function stockContract() {
  const result = spawnSync("python3", ["-I", "-B", "-", probe], {
    encoding: "utf8",
    timeout: 10_000,
    input: `import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("stock_prerequisites", sys.argv[1])
stock = importlib.util.module_from_spec(spec); spec.loader.exec_module(stock)
print(json.dumps({"libraries": sorted(stock.LIBRARIES), "packages": list(stock.PACKAGES),
                  "fonts": sorted(stock.bootstrap.FONT_PACKAGES)}))
`,
  });
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
  return JSON.parse(result.stdout) as { libraries: string[]; packages: string[]; fonts: string[] };
}

it("covers the pinned Chromium native dependencies and fonts with the stock probe and runtime assets", () => {
  const require = createRequire(import.meta.url);
  const playwright = path.dirname(require.resolve("playwright-core/package.json"));
  const { deps } = require(path.join(playwright, "lib/server/registry/nativeDeps.js"));
  const native = deps["ubuntu24.04-x64"] as { chromium: string[]; tools: string[] };
  const { libraries, packages, fonts } = stockContract();
  expect(native.chromium.length).toBeGreaterThan(0);
  // The probe requires each package installed and loads its libraries, which
  // also checks their transitive native dependencies on the stock image.
  expect(native.chromium.filter(name => !libraries.includes(name))).toEqual([]);
  expect(libraries.every(name => packages.includes(name))).toBe(true);
  // Fonts come from stock or the runtime's font assets. Capture is headless,
  // so the virtual display server is the only tool neither one supplies.
  const supplied = new Set([...libraries, ...packages, ...fonts]);
  expect(native.tools.filter(name => !supplied.has(name))).toEqual(["xvfb"]);
  // This is dependency coverage only; actual UID/sandbox PNG rendering must
  // pass qualify-cloud-capture.ts inside an installed v4 runtime.
});
