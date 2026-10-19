import { createRequire } from "node:module";
import { copyFile, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { runTool } from "../cloud-workspace-validation/runtime-bundle/toolchain";

// Opt-in, offline checks of an already acquired asset tree or complete runtime.
// No test acquires a provider VM, fetches packages or changes system directories.
const runtime = process.env.ZEROS_RUNTIME_SYSTEM_ASSETS_TEST_DIR;
const chrome = process.env.ZEROS_RUNTIME_SYSTEM_ASSETS_CHROMIUM;
const headless = process.env.ZEROS_RUNTIME_SYSTEM_ASSETS_HEADLESS;
const installed = `/opt/zeros-infra/r1-${"9".repeat(64)}`;
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function inView(source: string, capture: boolean | "headless" = false) {
  const root = await mkdtemp(path.join(os.tmpdir(), "zeros-assets-view-")); roots.push(root);
  const script = path.join(root, "probe.mjs"), helper = path.join(root, "cloud-runtime-assets.mjs");
  await copyFile("apps/desktop/src/engine/agents/containment/cloud-runtime-assets.mjs", helper);
  await writeFile(script, `import assert from 'node:assert/strict'; import fs from 'node:fs';
import {execFileSync} from 'node:child_process';
import {cloudRuntimeAssetEnvironment, runtimeSystemAssetFiles} from './cloud-runtime-assets.mjs';
const root=${JSON.stringify(installed)}, workerRoot=root+'/worker';
assert.equal(process.geteuid(),10003); assert.equal(process.getegid(),10003);
Object.assign(process.env,cloudRuntimeAssetEnvironment({profile:'v4',workerRoot}));
fs.mkdirSync(process.env.HOME,{recursive:true});
const execute=(command,args)=>execFileSync(command,args,{encoding:'utf8',env:process.env,cwd:process.env.HOME,timeout:15000,stdio:['ignore','pipe','pipe']}).trim();
${source}`);
  const args = ["--inh-caps=-all", "--ambient-caps=-all", "bwrap", "--unshare-user", "--uid", "10003", "--gid", "10003",
    "--unshare-net", "--unshare-ipc", "--cap-drop", "ALL", "--die-with-parent", "--ro-bind", "/usr", "/usr",
    "--ro-bind", "/lib", "/lib", "--ro-bind", "/lib64", "/lib64", "--symlink", "usr/bin", "/bin", "--symlink", "usr/sbin", "/sbin",
    // Chromium creates its own sandbox namespace and must write that child's
    // uid_map through proc. A readonly proc mount prevents sandbox creation;
    // the runtime itself remains readonly and the outer view has no network.
    capture ? "--bind" : "--ro-bind", "/proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp", "--tmpfs", "/home",
    "--ro-bind", await realpath(runtime!), installed, "--ro-bind", script, "/probe.mjs", "--ro-bind", helper, "/cloud-runtime-assets.mjs",
    "--clearenv", "--setenv", "HOME", "/home/probe", "--setenv", "PATH", `${installed}/bin:/usr/bin:/bin`, "--setenv", "LANG", "C.UTF-8"];
  if (capture) {
    const require = createRequire(import.meta.url);
    const playwright = path.dirname(require.resolve("playwright-core/package.json"));
    args.push("--ro-bind", playwright, "/playwright");
    if (capture === "headless") {
      const pin = require(path.join(playwright, "browsers.json")).browsers.find((browser: { name: string }) => browser.name === "chromium-headless-shell");
      const empty = path.join(root, "browsers");
      await mkdir(path.join(empty, `chromium_headless_shell-${pin.revision}/chrome-headless-shell-linux64`), { recursive: true });
      // Mask every pre-existing browser, including full Chromium in an older
      // runtime. Only the pinned shell's real directory is visible to launch.
      args.push("--ro-bind", empty, `${installed}/worker/design-browsers`,
        "--ro-bind", path.dirname(await realpath(headless!)),
        `${installed}/worker/design-browsers/chromium_headless_shell-${pin.revision}/chrome-headless-shell-linux64`,
        "--setenv", "PLAYWRIGHT_BROWSERS_PATH", `${installed}/worker/design-browsers`,
        "--setenv", "PLAYWRIGHT_HOST_PLATFORM_OVERRIDE", "ubuntu24.04-x64");
    } else args.push("--ro-bind", path.dirname(await realpath(chrome!)), "/browser");
  }
  args.push("--", `${installed}/bin/node`, "/probe.mjs");
  try {
    return JSON.parse(await runTool("setpriv", args, { cwd: root, env: { PATH: "/usr/bin:/bin" }, timeout: 30_000 }, "asset_native_view"));
  } catch (error) {
    const detail = String((error as { toolOutput?: string }).toolOutput ?? "").split("\n")
      .filter(line => /^(?:SyntaxError|AssertionError|Error|TypeError|browserType\.|bwrap:)/.test(line) || /\[err\].*(?:ERROR|FATAL|error while)/.test(line)).join("\n");
    throw new Error(`Native asset fixture failed: ${detail}`);
  }
}

it.runIf(process.platform === "linux" && !!runtime)("resolves and exercises LFS and fontconfig as UID/GID 10003 in the readonly runtime view", async () => {
  const result = await inView(`
const assets=JSON.parse(fs.readFileSync(workerRoot+'/runtime-system-assets.json','utf8'));
for(const relative of runtimeSystemAssetFiles(assets)) assert(fs.lstatSync(root+'/'+relative).isFile());
assert.throws(()=>fs.writeFileSync(root+'/bin/git-lfs','changed'),error=>error.code==='EROFS'||error.code==='EACCES');
assert(execute('git',['lfs','version']).startsWith('git-lfs/'));
assert(execute('git',['config','--system','--get','filter.lfs.process']).includes('/bin/git-lfs" filter-process'));
execute('git',['init','repo']);process.env.HOME+='/repo';
fs.writeFileSync(process.env.HOME+'/.gitattributes','*.bin filter=lfs diff=lfs merge=lfs -text\\n');
fs.writeFileSync(process.env.HOME+'/sample.bin','fixture large-file bytes');
execute('git',['add','.gitattributes','sample.bin']);
assert(execute('git',['show',':sample.bin']).startsWith('version https://git-lfs.github.com/spec/v1'));
fs.unlinkSync(process.env.HOME+'/sample.bin');execute('git',['checkout-index','--force','sample.bin']);
assert.equal(fs.readFileSync(process.env.HOME+'/sample.bin','utf8'),'fixture large-file bytes');
const names=[['Noto Color Emoji','fonts-noto-color-emoji'],['Unifont','fonts-unifont'],['IPAGothic','fonts-ipafont-gothic'],
['WenQuanYi Zen Hei','fonts-wqy-zenhei'],['Loma','fonts-tlwg-loma-otf'],['FreeSans','fonts-freefont-ttf'],['Bitstream Charter','xfonts-scalable']];
for(const [family,pkg] of names) assert(execute('fc-match',['--format=%{file}',family]).startsWith(workerRoot+'/design-fonts/'+pkg+'/'));
const fonts=execute('fc-list',['--format=%{file}\\n']).split('\\n').filter(file=>file.startsWith(workerRoot+'/design-fonts/')).length;
process.stdout.write(JSON.stringify({uid:process.geteuid(),gid:process.getegid(),families:names.length,fonts,lfs:true,readonly:true}));`);
  expect(result).toMatchObject({ uid: 10003, gid: 10003, families: 7, lfs: true, readonly: true });
  expect(result.fonts).toBeGreaterThanOrEqual(37);
}, 40_000);

it.runIf(process.platform === "linux" && !!runtime && !!headless)("selects the pinned headless shell, renders bundled fonts and retires the browser with full Chromium absent", async () => {
  const result = await inView(`
import {createRequire} from 'node:module';
import {once} from 'node:events';
const require=createRequire(import.meta.url), {chromium}=require('/playwright');
const pin=require('/playwright/browsers.json').browsers.find(browser=>browser.name==='chromium-headless-shell');
assert(!fs.existsSync(chromium.executablePath()));
const expected=workerRoot+'/design-browsers/chromium_headless_shell-'+pin.revision+'/chrome-headless-shell-linux64/chrome-headless-shell';
// Default headless selection, with exactly the capture worker's sandbox
// requirement. No channel, executable override or sandbox-disabling flags.
const server=await chromium.launchServer({headless:true,chromiumSandbox:true,timeout:15000,host:'127.0.0.1'});
const child=server.process(), exited=once(child,'exit');
const identities=[];
const identity=pid=>{
 try {const stat=fs.readFileSync('/proc/'+pid+'/stat','utf8').split(') ')[1].split(' ');return {start:stat[19],state:stat[0]};}
 catch(error){if(error.code==='ENOENT'||error.code==='ESRCH') return null;throw error;}
};
try {
 assert.equal(fs.realpathSync(child.spawnfile),expected);
 assert(!child.spawnargs.includes('--no-sandbox'));
 assert(child.spawnargs.includes('--headless'));
 const browser=await chromium.connect(server.wsEndpoint());
 assert.equal(browser.version(),pin.browserVersion);
 const context=await browser.newContext({viewport:{width:640,height:320},javaScriptEnabled:false,offline:true,serviceWorkers:'block',acceptDownloads:false});
 await context.route('**/*',route=>route.abort('blockedbyclient'));
 const page=await context.newPage();
 const fonts=[['FreeSans','Example'],['IPAGothic','日本語'],['WenQuanYi Zen Hei','漢字'],['Loma','ภาษาไทย'],['Noto Color Emoji','🙂'],['Unifont','λ']];
 await page.setContent(fonts.map(([family,text],i)=>'<div id="f'+i+'" style="font-family:'+family+';font-size:32px">'+text+'</div>').join(''));
 await page.evaluate(()=>document.fonts.ready);
 const session=await context.newCDPSession(page);await session.send('DOM.enable');await session.send('CSS.enable');
 const {root:document}=await session.send('DOM.getDocument');
 for(let i=0;i<fonts.length;i++) {
  const {nodeId}=await session.send('DOM.querySelector',{nodeId:document.nodeId,selector:'#f'+i});
  const used=await session.send('CSS.getPlatformFontsForNode',{nodeId});
  assert(used.fonts.some(font=>font.familyName===fonts[i][0]&&font.glyphCount>0),fonts[i][0]);
 }
 const png=await page.screenshot({type:'png'});assert(png.subarray(1,4).equals(Buffer.from('PNG')));
 assert.equal(png.readUInt32BE(16),640);assert.equal(png.readUInt32BE(20),320);
 const census=await browser.newBrowserCDPSession();
 const {processInfo}=await census.send('SystemInfo.getProcessInfo');
 assert(processInfo.some(process=>process.type==='browser'&&process.id===child.pid));
 assert(processInfo.some(process=>process.type==='renderer'));
 for(const {id:pid} of processInfo) {const before=identity(pid);assert(before);identities.push({pid,...before});}
 await context.close();await browser.close();
} finally {await server.close();}
assert.deepEqual(await exited,[0,null]);
for(const before of identities) {
 const after=identity(before.pid);
 assert(!after||after.start!==before.start||after.state==='Z'||after.state==='X');
}
process.stdout.write(JSON.stringify({uid:process.geteuid(),gid:process.getegid(),families:6,png:true,
 sandbox:true,headlessOnly:true,version:pin.browserVersion,retired:identities.length}));`, "headless");
  expect(result).toMatchObject({ uid: 10003, gid: 10003, families: 6, png: true, sandbox: true, headlessOnly: true });
  expect(result.retired).toBeGreaterThanOrEqual(2);
}, 40_000);

it.runIf(process.platform === "linux" && !!runtime && !!chrome)("renders bundled fonts through sandboxed Chromium with the cloud capture settings", async () => {
  const result = await inView(`
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url), {chromium}=require('/playwright');
const browser=await chromium.launch({executablePath:'/browser/${path.basename(chrome ?? "chrome")}',headless:true,chromiumSandbox:true,timeout:15000});
try {
 const context=await browser.newContext({javaScriptEnabled:false,offline:true,serviceWorkers:'block',acceptDownloads:false});
 await context.route('**/*',route=>route.abort('blockedbyclient'));
 const page=await context.newPage();
 const fonts=[['FreeSans','Example'],['IPAGothic','日本語'],['WenQuanYi Zen Hei','漢字'],['Loma','ภาษาไทย'],['Noto Color Emoji','🙂'],['Unifont','λ']];
 await page.setContent(fonts.map(([family,text],i)=>'<span id="f'+i+'" style="font-family:'+family+';font-size:32px">'+text+'</span>').join(''));
 await page.evaluate(()=>document.fonts.ready);
 const session=await context.newCDPSession(page);await session.send('DOM.enable');await session.send('CSS.enable');
 const {root:document}=await session.send('DOM.getDocument');
 for(let i=0;i<fonts.length;i++) {
  const {nodeId}=await session.send('DOM.querySelector',{nodeId:document.nodeId,selector:'#f'+i});
  const used=await session.send('CSS.getPlatformFontsForNode',{nodeId});
  assert(used.fonts.some(font=>font.familyName===fonts[i][0]&&font.glyphCount>0),fonts[i][0]);
 }
 const png=await page.screenshot({type:'png'});assert(png.subarray(1,4).equals(Buffer.from('PNG')));
 process.stdout.write(JSON.stringify({uid:process.geteuid(),families:fonts.length,png:true,sandbox:true}));
} finally {await browser.close();}`, true);
  expect(result).toEqual({ uid: 10003, families: 6, png: true, sandbox: true });
}, 40_000);
