import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { buildEngineImage } from "../cloud-workspace-validation/image";
import { RUNTIME_HELPERS } from "../cloud-workspace-validation/runtime-bundle/closure";

it.each(["generated", "dockerfile", "boat", "v4"])("loads the complete Computer report closure from the %s recipe", recipe => {
  const sandbox = path.resolve("scripts/cloud-workspace-validation/sandbox");
  const directory = mkdtempSync(path.join(tmpdir(), "zeros-computer-report-recipe-"));
  const helpers = ["cloud-computer-self-test.mjs", "cloud-resource-admission.mjs", "cgroup-resources.mjs", "cloud-runner-base.mjs"];
  try {
    const recipeText = recipe === "generated" ? buildEngineImage().dockerfile : recipe === "v4" ? "" : readFileSync(
      recipe === "dockerfile" ? "scripts/cloud-workspace-validation/Dockerfile" :
        "scripts/cloud-workspace-validation/boat-image/templates/build.sh", "utf8");
    for (const name of helpers) {
      const target = `/opt/zeros-runtime/lib/zeros/${name}`;
      const installed = recipe === "v4" ? RUNTIME_HELPERS.some(file => file.target === `lib/zeros/${name}` && !file.optional) :
        recipe === "boat" ? /for name in (.*); do/.exec(recipeText)?.[1].split(" ").includes(name) :
          recipeText.split("\n").some(line => /^(COPY |RUN install )/.test(line) && line.includes(target));
      if (installed) writeFileSync(path.join(directory, name), readFileSync(path.join(sandbox, name)));
    }
    const result = spawnSync(process.execPath, ["--input-type=module", "--eval",
      `const m=await import(${JSON.stringify(pathToFileURL(path.join(directory, helpers[0])).href)});` +
      `if(m.COMPUTER_SELF_TEST_SCHEMA!=="zeros.computer-self-test/v1")process.exit(2);`], {
      encoding: "utf8", timeout: 10_000, env: { PATH: process.env.PATH, LANG: "C.UTF-8" },
    });
    expect(result.status, result.stderr).toBe(0);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
