import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import * as bundle from "../cloud-workspace-validation/runtime-bundle/qualification.mjs";
import { CloudComputerQualificationSelectionSchema } from "../../packages/protocol/src/cloud-build-qualification";
import { bootFixture } from "./cloud-boot-admission-fixture";
import { buildEngineImage } from "../cloud-workspace-validation/image";
import { RUNTIME_HELPERS } from "../cloud-workspace-validation/runtime-bundle/closure";

it("loads the unchanged Q1a selection contract from a relocated tiny graph with no runtime compiler or functional role imports", async () => {
  expect(bundle.buildCloudBootContract, "standalone compiled Q1a runtime contract").toBeTypeOf("function");
  const directory = await mkdtemp(path.join(os.tmpdir(), "zeros-boot-contract-"));
  try {
    const output = path.join(directory, "worker/dist-engine/cloud-boot-contract.mjs");
    const metadata = await bundle.buildCloudBootContract(process.cwd(), output);
    const graph = Object.keys(metadata.inputs);
    expect(graph.some(file => file.endsWith("packages/protocol/src/cloud-build-qualification.ts"))).toBe(true);
    expect(graph.some(file => /qualification-runtime|qualify-cloud-(actor|capture|human|runners)|cloud-engine-launcher/.test(file))).toBe(false);
    const selected = bootFixture().selection;
    const candidates = [selected, { mode: "full" }, null, { mode: "build" }, { ...selected, unknown: true },
      { ...selected, snapshot: { ...selected.snapshot, name: "fixture-beta-computer-v1" } }];
    const result = execFileSync(process.execPath, ["--input-type=module", "-e", `
      import {registerHooks} from 'node:module';
      import {pathToFileURL} from 'node:url';
      import {readFileSync} from 'node:fs';
      registerHooks({resolve(s,c,next){if(s.endsWith('.ts')||['tsx','esbuild'].includes(s.split('/')[0]))throw new Error('unexpected compiler');return next(s,c);}});
      const m=await import(pathToFileURL(process.argv[1]));
      const values=JSON.parse(readFileSync(0,'utf8'));
      process.stdout.write(JSON.stringify(values.map(v=>{try{m.parseCloudBootSelection(v);return true}catch{return false}})));
    `, output], { input: JSON.stringify(candidates), encoding: "utf8", timeout: 5000,
      env: { PATH: process.env.PATH, NODE_OPTIONS: "", NODE_PATH: "" } });
    expect(JSON.parse(result)).toEqual(candidates.map(value => CloudComputerQualificationSelectionSchema.safeParse(value).success));
    expect((await readFile(output, "utf8"))).not.toContain(process.cwd());
    expect(execFileSync(process.execPath, [output], { encoding: "utf8", timeout: 5000 })).toBe("");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
it("stages every new root import in each runtime recipe while keeping the Local build untouched", async () => {
  const generated = buildEngineImage(), docker = await readFile("scripts/cloud-workspace-validation/Dockerfile", "utf8");
  const boat = await readFile("scripts/cloud-workspace-validation/boat-image/templates/build.sh", "utf8");
  for (const name of ["cloud-boot-admission.mjs", "cloud-boot-proof.mjs", "cloud-boot-locks.mjs", "cloud-boot-retirement.mjs"]) {
    expect(RUNTIME_HELPERS.some(file => file.target === `lib/zeros/${name}`)).toBe(true);
    expect(generated.contextList.some(file => file.archivePath === `sandbox/${name}`)).toBe(true);
    expect(docker).toContain(`COPY sandbox/${name} /opt/zeros-runtime/lib/zeros/${name}`);
    expect(/for name in (.*); do/.exec(boat)![1].split(" ")).toContain(name);
  }
  expect(generated.dockerfile).toContain("qualification.mjs --boot-contract-only");
  const pkg = JSON.parse(await readFile("package.json", "utf8"));
  expect(pkg.scripts["build:engine"]).not.toMatch(/boot-contract|qualification/);
  expect(await readFile("tsup.config.ts", "utf8")).not.toContain("cloud-boot");
});
it("publication requires the compiled contract for new helpers while accepting an unchanged old archive", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "zeros-boot-publication-"));
  const entry = path.join(root, "worker", bundle.BOOT_CONTRACT_BUNDLE);
  try {
    await bundle.buildCloudBootContract(process.cwd(), entry);
    await mkdir(path.join(root, "bin")); await symlink(process.execPath, path.join(root, "bin/node"));
    const source = await readFile("scripts/cloud-workspace-validation/runtime-bundle/probe.cjs", "utf8");
    const run = async (files: string[]) => {
      await writeFile(path.join(root, "manifest.json"), JSON.stringify({ files: files.map(file => ({ path: file })) }));
      const module = { exports: undefined as unknown }, lines: string[] = [];
      let exitCode: number | undefined;
      runInNewContext(source.replace("Object.entries(checks)", "Object.entries({ boot_contract: checks.boot_contract })") +
        "\nmodule.exports = main;", { module, require: createRequire(import.meta.url),
        process: { argv: ["node", "probe.cjs", root, "engine"], env: { HOME: path.join(root, "home"), PATH: process.env.PATH },
          stdout: { write: (line: string) => lines.push(line) }, exit: (code: number) => { exitCode = code; } } });
      await (module.exports as () => Promise<void>)();
      return { exitCode, output: lines.join("") };
    };
    const fresh = await run([`worker/${bundle.BOOT_CONTRACT_BUNDLE}`, "lib/zeros/cloud-boot-admission.mjs"]);
    expect(fresh.exitCode).toBe(0); expect(fresh.output).toContain('"checks":["boot_contract"]');
    await rename(entry, entry + ".saved");
    for (const files of [[`worker/${bundle.BOOT_CONTRACT_BUNDLE}`], ["lib/zeros/cloud-boot-admission.mjs"]]) {
      const missing = await run(files);
      expect(missing.exitCode).toBe(1); expect(missing.output).toContain('"failedChecks":["boot_contract"]');
    }
    const old = await run([]);
    expect(old.exitCode).toBe(0); expect(old.output).toContain('"checks":[]');
  } finally { await rm(root, { recursive: true, force: true }); }
});
