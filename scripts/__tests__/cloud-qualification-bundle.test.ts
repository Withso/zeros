import { execFileSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { buildCloudQualificationRoles, QUALIFICATION_BUNDLE } from "../cloud-workspace-validation/runtime-bundle/qualification.mjs";

const sandbox = "scripts/cloud-workspace-validation/sandbox";
let worker: string;
let root: string;
let metadata: Awaited<ReturnType<typeof buildCloudQualificationRoles>>;
beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "zeros-qualification-artifact-"));
  worker = path.join(root, "worker");
  metadata = await buildCloudQualificationRoles(process.cwd(), path.join(worker, QUALIFICATION_BUNDLE));
  await mkdir(path.join(worker, sandbox), { recursive: true });
  await copyFile(path.join(sandbox, "cloud-qualification-loader.mjs"), path.join(worker, sandbox, "cloud-qualification-loader.mjs"));
  // No source files in this worker: Node cannot accidentally compile one.
  await symlink(path.resolve("node_modules"), path.join(worker, "node_modules"));
  await mkdir(path.join(root, "bin"));
  await symlink(process.execPath, path.join(root, "bin/node"));
}, 30_000);
afterAll(async () => { if (root) await rm(root, { recursive: true, force: true }); });

function execute(source: string) {
  return execFileSync(process.execPath, ["--input-type=module", "-e", source, worker], {
    encoding: "utf8", timeout: 30_000, env: { ...process.env, NODE_OPTIONS: "", NODE_PATH: "" },
  });
}

it("loads the relocated production graph without TypeScript, transform workers or role execution", () => {
  const value = execute(`
    import { registerHooks } from 'node:module';
    import { pathToFileURL } from 'node:url';
    import { readdirSync, readFileSync } from 'node:fs';
    const root = process.argv[1];
    registerHooks({ resolve(specifier, context, next) {
      if (['tsx', 'esbuild'].includes(specifier.split('/')[0]) || specifier.endsWith('.ts'))
        throw new Error('unexpected runtime transform');
      return next(specifier, context);
    } });
    const loader = await import(pathToFileURL(root + '/${sandbox}/cloud-qualification-loader.mjs'));
    process.argv[1] = root + '/${sandbox}/qualify-cloud-engine.mjs';
    const { roles, unregister } = await loader.loadCloudQualificationRoles();
    const compiled = await import(pathToFileURL(root + '/${QUALIFICATION_BUNDLE}'));
    await unregister();
    const children = process.platform !== 'linux' ? [] : readdirSync('/proc').filter(name => /^[0-9]+$/.test(name)).filter(name => {
      try { const s = readFileSync('/proc/' + name + '/stat', 'utf8').split(') ')[1].split(' ');
        return Number(s[1]) === process.pid && s[0] !== 'Z'; } catch { return false; }
    });
    process.stdout.write(JSON.stringify({ roles: Object.keys(roles), children,
      sameRuntime: compiled.createCloudCaptureQualificationRuntime === roles.createCloudQualificationRuntime,
      sameActor: compiled.qualifyCloudActorTools === roles.qualifyCloudActorTools }));
  `);
  expect(JSON.parse(value)).toEqual({ roles: ["createCloudQualificationRuntime", "qualifyCloudActorTools", "qualifyCloudCapture", "qualifyCloudHumanServices"],
    children: [], sameRuntime: true, sameActor: true });
});

it("runs the compiled serialized identity proof with every privilege guard intact", () => {
  const value = execute(`
    import { pathToFileURL } from 'node:url';
    import vm from 'node:vm';
    const { cloudRoleIdentityProbe } = await import(pathToFileURL(process.argv[1] + '/${QUALIFICATION_BUNDLE}'));
    const names = Object.fromEntries(['mnt','pid','user','net','cgroup'].map((name,i) => [name,name+':['+(4026531835+i)+']']));
    const namespace = file => names[file.split('/').at(-1)];
    const script = cloudRoleIdentityProbe({ workloadDirectory:'/sys/fs/cgroup/fixture/workload', credential:'absent' }, namespace);
    const run = ({ uid=10003, capability='0000000000000000', noNewPrivs=1, seccomp=2, group='/fixture/workload', foreign=false, credential=false }={}) => {
      const status = ['CapEff','CapPrm','CapInh','CapBnd','CapAmb'].map(name=>name+':\\t'+capability).join('\\n')+'\\nNoNewPrivs:\\t'+noNewPrivs+'\\nSeccomp:\\t'+seccomp+'\\n';
      let code = null;
      vm.runInNewContext(script, { require: name => {
        if(name!=='node:fs')throw new Error('unexpected module');
        return { readFileSync: file => file==='/proc/self/status'?status:'0::'+group+'\\n', readlinkSync: file => foreign?'mnt:[1]':namespace(file) };
      }, process: { getuid:()=>uid, geteuid:()=>uid, getgid:()=>10003, getegid:()=>10003,
        env:credential?{OPENAI_API_KEY:'synthetic'}:{}, exit:value=>{code=value;} } });
      return code;
    };
    process.stdout.write(JSON.stringify([run(),run({uid:0}),run({capability:'0000000000000001'}),run({noNewPrivs:0}),
      run({seccomp:0}),run({group:'/foreign'}),run({foreign:true}),run({credential:true})]));
  `);
  expect(JSON.parse(value)).toEqual([null, 91, 91, 91, 91, 91, 91, 91]);
});

it("keeps module-relative assets, CLI guards and one original boundary graph", async () => {
  const source = await readFile(path.join(worker, QUALIFICATION_BUNDLE), "utf8");
  expect(source).not.toContain(process.cwd());
  for (const name of ["pty/pty-host-client.ts", "transport/cloud-ssh-session.mjs"])
    expect(source).toContain(`../apps/desktop/src/engine/${name}`);
  for (const name of ["qualify-cloud-actor-tools.ts", "qualify-cloud-capture.ts", "qualify-cloud-human-services.ts"])
    expect(source).toContain(`../${sandbox}/${name}`);
  for (const name of ["cloud-execution-boundary.ts", "cloud-owned-workloads.ts", "cloud-workload-custody.ts"])
    expect(Object.keys(metadata.inputs).filter(file => file.endsWith(`/containment/${name}`))).toHaveLength(1);
  expect(Object.values(metadata.outputs).flatMap(output => output.imports).some(edge => edge.path.startsWith("@zeros/") || edge.path.endsWith(".ts"))).toBe(false);
  // Flattening import.meta must not turn the generated entry into all three
  // standalone role CLIs. No process or proof is started just by loading it.
  expect(execFileSync(process.execPath, [path.join(worker, QUALIFICATION_BUNDLE)], { encoding: "utf8", timeout: 30_000 })).toBe("");
});

it("builds only in cloud recipes and stages the generated dist-engine payload", async () => {
  const build = await readFile("scripts/cloud-workspace-validation/runtime-bundle/build.ts", "utf8");
  expect(build).toContain('["scripts/cloud-workspace-validation/runtime-bundle/qualification.mjs"]');
  expect(build).toContain('path.join(runtime, "worker/dist-engine")');
  for (const recipe of ["scripts/cloud-workspace-validation/Dockerfile", "scripts/cloud-workspace-validation/boat-image/templates/build.sh"])
    expect(await readFile(recipe, "utf8")).toContain("node scripts/cloud-workspace-validation/runtime-bundle/qualification.mjs");
  const pkg = JSON.parse(await readFile("package.json", "utf8"));
  expect(pkg.scripts["build:engine"]).not.toContain("qualification");
  expect(await readFile("tsup.config.ts", "utf8")).not.toContain("qualification");
});

async function closureProbe(declared = true) {
  await writeFile(path.join(root, "manifest.json"), JSON.stringify({ files: declared ? [{ path: `worker/${QUALIFICATION_BUNDLE}` }] : [] }));
  const source = await readFile("scripts/cloud-workspace-validation/runtime-bundle/probe.cjs", "utf8");
  const module = { exports: undefined as unknown }, output: string[] = [];
  let exitCode: number | undefined;
  runInNewContext(source.replace("Object.entries(checks)", "Object.entries({ qualification_roles: checks.qualification_roles })") +
    "\nmodule.exports = main;", { module, require: createRequire(import.meta.url),
    process: { argv: ["node", "probe.cjs", root, "engine"], env: { HOME: path.join(root, "home"), PATH: process.env.PATH },
      stdout: { write: (line: string) => output.push(line) }, exit: (code: number) => { exitCode = code; } } });
  await (module.exports as () => Promise<void>)();
  return { exitCode, output: output.join("") };
}

it("runs the publication probe against the generated graph and refuses a missing staged entry", async () => {
  const good = await closureProbe();
  expect(good.exitCode).toBe(0);
  expect(good.output).toContain('"checks":["qualification_roles"]');
  const bundle = path.join(worker, QUALIFICATION_BUNDLE);
  await rename(bundle, bundle + ".saved");
  try {
    const missing = await closureProbe();
    expect(missing.exitCode).toBe(1);
    expect(missing.output).toContain('"failedChecks":["qualification_roles"]');
    const old = await closureProbe(false);
    expect(old.exitCode).toBe(0);
    expect(old.output).toContain('"checks":[]');
  } finally { await rename(bundle + ".saved", bundle); }
});

it("preserves per-module createRequire resolution after relocation", async () => {
  const source = await mkdtemp(path.join(os.tmpdir(), "zeros-qualification-source-"));
  const output = await mkdtemp(path.join(os.tmpdir(), "zeros-qualification-relocated-"));
  try {
    await writeFile(path.join(source, "package.json"), "{}");
    await mkdir(path.join(source, sandbox), { recursive: true });
    for (const name of ["cloud-qualification-runtime", "qualify-cloud-actor-tools", "qualify-cloud-capture", "qualify-cloud-human-services", "cloud-role-identity"])
      await writeFile(path.join(source, sandbox, name + ".ts"), name === "cloud-role-identity"
        ? `import {createRequire} from 'node:module'; export const value = createRequire(import.meta.url)('./source-relative.json');`
        : "export {};\n");
    await buildCloudQualificationRoles(source, path.join(output, QUALIFICATION_BUNDLE));
    await mkdir(path.join(output, sandbox), { recursive: true });
    await writeFile(path.join(output, sandbox, "source-relative.json"), '{"original":true}');
    const stdout = execFileSync(process.execPath, ["--input-type=module", "-e",
      `import {pathToFileURL} from 'node:url'; const m=await import(pathToFileURL(process.argv[1])); process.stdout.write(JSON.stringify(m.value));`,
      path.join(output, QUALIFICATION_BUNDLE)], { encoding: "utf8", timeout: 30_000 });
    expect(JSON.parse(stdout)).toEqual({ original: true });
  } finally { await rm(source, { recursive: true, force: true }); await rm(output, { recursive: true, force: true }); }
});
