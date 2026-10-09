import { execFileSync, spawn } from "node:child_process";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { build } from "esbuild";
import { expect, it } from "vitest";
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1XcAAAAASUVORK5CYII=";
const dropArgs=["--reuid=10003","--regid=10003","--clear-groups","--no-new-privs","--inh-caps=-all","--ambient-caps=-all","--bounding-set=-all"];
let canLaunch=process.platform==="linux"&&process.geteuid?.()===10003;
if(process.platform==="linux"&&!canLaunch)try{
  canLaunch=execFileSync("sudo",["-n","/usr/bin/setpriv",...dropArgs,"/usr/bin/id","-u"],{env:{PATH:"/usr/bin:/bin"},encoding:"utf8",stdio:["ignore","pipe","ignore"]}).trim()==="10003";
}catch{/* Explicit skip when the credential-free non-root fixture cannot run. */}
it.skipIf(!canLaunch).each(["cjs", "esm"] as const)("runs the fixed10003 worker's bounded entrypoint in the shipped %s format", async format => {
  const root = await mkdtemp(path.join(os.tmpdir(), "zeros-capture-entry-"));
  try {
    await chmod(root,0o755);
    const file = path.join(root, format === "cjs" ? "design-capture-worker.cjs" : "design-capture-worker.mjs");
    await build({ entryPoints: ["apps/desktop/src/engine/design/design-capture-worker.ts"], outfile: file, bundle: true,
      platform: "node", format, logLevel: "silent", plugins: [{ name: "render-fixture", setup(builder) {
        builder.onResolve({ filter: /^playwright-core$/ }, () => ({ path: "renderer", namespace: "fixture" }));
        builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: `
          const page={setDefaultTimeout(){},async setContent(){},async evaluate(){},async screenshot(){return Buffer.from("${png}","base64")}};
          const context={async route(){},async newPage(){return page},async close(){}};
          export const chromium={async launch(){return {async newContext(){return context},async close(){},version(){return "fixture"}}}};
        ` }));
      } }] });
    // Only this disposable entry fixture drops UID. Production capture inherits
    // the original non-root engine identity; it never invokes setpriv.
    const child = process.geteuid?.()===10003?spawn(process.execPath,[file],{env:{},stdio:["pipe","pipe","pipe"]})
      :spawn("sudo",["-n","/usr/bin/setpriv",...dropArgs,process.execPath,file],{env:{PATH:"/usr/bin:/bin"},stdio:["pipe","pipe","pipe"]});
    const chunks: Buffer[] = []; child.stdout.on("data", chunk => chunks.push(chunk)); child.stderr.resume();
    const exited = new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
    const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
    try {
      child.stdin.end(JSON.stringify({ version: 1, html: "<body></body>", revision: "fixture", width: 1, height: 1, colorScheme: "light" }));
      expect(await exited).toBe(0);
      expect(Buffer.concat(chunks).length).toBeGreaterThan(0);
      expect(JSON.parse(Buffer.concat(chunks).toString())).toMatchObject({ data: png, identity: { uid: 10003, gid: 10003 } });
    } finally { clearTimeout(timer); }
  } finally { await rm(root, { recursive: true, force: true }); }
});
