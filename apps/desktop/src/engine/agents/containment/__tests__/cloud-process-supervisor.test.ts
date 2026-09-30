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
  it("stops adopted descendants after their original leader exits without stopping another domain",async()=>{
    const proof=path.join(directory,randomBytes(16).toString("hex"));
    const ready=path.join(directory,"adopted-ready"),release=path.join(directory,"adopted-release");
    const script=path.join(directory,"detached.py");
    await writeFile(script,`import os,time\nowner=os.getppid()\nif os.fork()==0:\n os.setsid()\n if os.fork()==0:\n  deadline=time.monotonic()+12\n  while os.getppid()!=owner and time.monotonic()<deadline:time.sleep(.01)\n  assert os.getppid()==owner\n  open(${JSON.stringify(ready)},'w').write(str(os.getpid()))\n  while not os.path.exists(${JSON.stringify(release)}) and time.monotonic()<deadline:time.sleep(.01)\n os._exit(0)\nos._exit(19)\n`);
    const unrelated=spawn("/usr/bin/sleep",["20"],{stdio:"ignore"});
    const unrelatedExit=new Promise(resolve=>unrelated.once("exit",resolve));
    const tracked=new CloudSupervisedProcess(spawn(binary,[proof,String(process.pid),"--","/usr/bin/python3",script],{stdio:"ignore"}),proof);
    try{
      let descendant:string|undefined;
      await expect.poll(async()=>{
        try{descendant=await readFile(ready,"utf8");return Boolean(descendant);}catch{return false;}
      },{timeout:3000}).toBe(true);
      await tracked.stopAndProve();
      expect(await tracked.wait()).toEqual({code:19,signal:null});
      await expect(readFile(`/proc/${descendant}/stat`)).rejects.toMatchObject({code:"ENOENT"});
      expect(unrelated.exitCode).toBeNull();expect(unrelated.signalCode).toBeNull();
    }finally{
      await writeFile(release,"release");await tracked.wait();
      unrelated.kill("SIGKILL");await unrelatedExit;
    }
  },15000);
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
