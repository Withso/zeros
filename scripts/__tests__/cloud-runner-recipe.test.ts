import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { buildEngineImage } from "../cloud-workspace-validation/image";

it.each(["generated", "dockerfile", "boat"])("loads both newly required helpers from the %s install inventory", recipe => {
  const sandbox = path.resolve("scripts/cloud-workspace-validation/sandbox");
  const directory = mkdtempSync(path.join(tmpdir(), "zeros-runner-recipe-"));
  const helpers = ["cloud-setup-performance.mjs", "cloud-runner-base.mjs"];
  try {
    const recipeText = recipe === "generated" ? buildEngineImage().dockerfile : readFileSync(
      recipe === "dockerfile" ? "scripts/cloud-workspace-validation/Dockerfile" :
        "scripts/cloud-workspace-validation/boat-image/templates/build.sh", "utf8");
    for (const name of helpers) {
      const target = `/opt/zeros-runtime/lib/zeros/${name}`;
      const installed = recipe === "boat" ?
        /for name in (.*); do/.exec(recipeText)?.[1].split(" ").includes(name) :
        recipeText.split("\n").some(line => /^(COPY |RUN install )/.test(line) && line.includes(target));
      if (installed) writeFileSync(path.join(directory, name), readFileSync(path.join(sandbox, name)));
    }
    // Run the real module loader against only the installed files. Repository
    // sources and the current working directory cannot supply an absent helper.
    const imports = helpers.map(name => `await import(${JSON.stringify(pathToFileURL(path.join(directory, name)).href)});`).join("\n");
    const result = spawnSync(process.execPath, ["--input-type=module", "--eval", imports], {
      encoding: "utf8", timeout: 10_000, env: { PATH: process.env.PATH, LANG: "C.UTF-8" },
    });
    expect(result.status, result.stderr).toBe(0);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
