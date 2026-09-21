import {spawn,spawnSync} from "node:child_process";
import {randomBytes} from "node:crypto";
import {mkdtemp,readFile,rm,writeFile} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {afterAll,beforeAll,describe,expect,it} from "vitest";
import {CloudSupervisedProcess} from "../cloud-supervised-process";

describe.skipIf(process.platform!=="linux")("cloud process reaping proof",()=>{
  let directory:string,binary:string;
  beforeAll(async()=>{
    directory=await mkdtemp(path.join(os.tmpdir(),"zeros-reaper-"));binary=path.join(directory,"reaper");
    const result=spawnSync("cc",["-std=c11","-O2","-Wall","-Wextra","-Werror",
      path.resolve("apps/desktop/src/engine/agents/containment/cloud-process-supervisor.c"),"-o",binary],{encoding:"utf8"});
    expect(result.status,result.stderr).toBe(0);
  });
  afterAll(async()=>{await rm(directory,{recursive:true,force:true});});
  it("waits for an adopted setsid descendant after its original leader exits",async()=>{
    const proof=path.join(directory,randomBytes(16).toString("hex")),marker=path.join(directory,"descendant");
    const script=path.join(directory,"fork.py");
    await writeFile(script,`import os,time\nif os.fork()==0:\n os.setsid()\n if os.fork()==0:\n  time.sleep(0.3)\n  open(${JSON.stringify(marker)},'w').write('finished')\n os._exit(0)\nos._exit(17)\n`);
    const child=spawn(binary,[proof,String(process.pid),"--","/usr/bin/python3",script],{stdio:"ignore"});
    const exit=await new Promise<number|null>(resolve=>child.once("exit",resolve));
    expect(exit).toBe(17);expect(await readFile(marker,"utf8")).toBe("finished");
    expect(await readFile(proof,"utf8")).toBe("zeros-process-domain-reaped-v1\n");
  });
  it("requires a complete receipt and permits idempotent proven retirement",async()=>{
    const proof=path.join(directory,randomBytes(16).toString("hex"));
    const tracked=new CloudSupervisedProcess(spawn(binary,[proof,String(process.pid),"--","/usr/bin/true"]),proof);
    await tracked.wait();await tracked.stopAndProve();await tracked.stopAndProve();
    await expect(readFile(proof)).rejects.toMatchObject({code:"ENOENT"});
    const invalid=path.join(directory,randomBytes(16).toString("hex"));await writeFile(invalid,"",{mode:0o600});
    const lost=new CloudSupervisedProcess(spawn("/usr/bin/true"),invalid);await lost.wait();
    await expect(lost.stopAndProve()).rejects.toThrow(/unproven/);
  });
  it("never accepts or overwrites an existing receipt",async()=>{
    const proof=path.join(directory,randomBytes(16).toString("hex"));await writeFile(proof,"prior");
    const child=spawnSync(binary,[proof,String(process.pid),"--","/usr/bin/true"]);
    expect(child.status).toBe(125);expect(await readFile(proof,"utf8")).toBe("prior");
  });
  it("proves an immediate Stop without killing the uninitialized receipt owner",async()=>{
    for(let iteration=0;iteration<20;iteration++){
      const proof=path.join(directory,randomBytes(16).toString("hex"));
      const tracked=new CloudSupervisedProcess(spawn(binary,[proof,String(process.pid),"--","/usr/bin/sleep","10"]),proof);
      await tracked.stopAndProve();await expect(readFile(proof)).rejects.toMatchObject({code:"ENOENT"});
    }
  });
  it("refuses a replaced immediate parent before launching any command",async()=>{
    const proof=path.join(directory,randomBytes(16).toString("hex")),marker=path.join(directory,"wrong-parent");
    const result=spawnSync(binary,[proof,"1","--","/usr/bin/touch",marker]);
    expect(result.status).toBe(125);await expect(readFile(marker)).rejects.toMatchObject({code:"ENOENT"});
  });
});
