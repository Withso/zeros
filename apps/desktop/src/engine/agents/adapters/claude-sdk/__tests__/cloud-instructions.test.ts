import {mkdtemp,mkdir,writeFile,symlink,rm} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {describe,it,expect} from "vitest";
import {cloudClaudeInstructions,cloudInstructionFiles} from "../cloud-instructions";

describe.runIf(process.platform==="linux")("bounded cloud repository instruction reads",()=>{
  it("reads both files, preserves the engine instruction, and excludes optional unsafe inputs",async()=>{
    const root=await mkdtemp(path.join(os.tmpdir(),"zeros-instructions-")),outside=await mkdtemp(path.join(os.tmpdir(),"zeros-instructions-outside-"));
    try{
      await writeFile(path.join(root,"CLAUDE.md"),"Claude instruction");
      await writeFile(path.join(root,"AGENTS.md"),"Agents instruction");
      expect(cloudClaudeInstructions(root)).toContain("Claude instruction");expect(cloudClaudeInstructions(root)).toContain("Agents instruction");
      await writeFile(path.join(outside,"secret.md"),"outside sentinel");
      await rm(path.join(root,"CLAUDE.md"));await symlink(path.join(outside,"secret.md"),path.join(root,"CLAUDE.md"));
      expect(cloudClaudeInstructions(root)).toContain("Agents instruction");expect(cloudClaudeInstructions(root)).not.toContain("outside sentinel");
      await writeFile(path.join(root,"AGENTS.md"),"x".repeat(64*1024+1));expect(cloudClaudeInstructions(root)).toBeUndefined();
    }finally{await Promise.all([rm(root,{recursive:true,force:true}),rm(outside,{recursive:true,force:true})]);}
  });
  it("provides Cursor fixed markdown reads with aggregate count/byte bounds and no arbitrary paths",async()=>{
    const root=await mkdtemp(path.join(os.tmpdir(),"zeros-cursor-instructions-"));
    try{
      await mkdir(path.join(root,".cursor/rules"),{recursive:true});
      await writeFile(path.join(root,"AGENTS.md"),"Agents sentinel");
      await writeFile(path.join(root,".cursor/rules/rule.mdc"),"Rule sentinel");
      await writeFile(path.join(root,"private.env"),"private sentinel");
      expect(cloudInstructionFiles(root,["AGENTS.md",".cursor/rules/rule.mdc","private.env","../private.env"])).toContain("Rule sentinel");
      expect(cloudInstructionFiles(root,["AGENTS.md",".cursor/rules/rule.mdc","private.env","../private.env"])).not.toContain("private sentinel");
      await writeFile(path.join(root,"AGENTS.md"),"a".repeat(64*1024));
      await writeFile(path.join(root,".cursor/rules/rule.mdc"),"b".repeat(64*1024));
      expect(Buffer.byteLength(cloudInstructionFiles(root,["AGENTS.md",".cursor/rules/rule.mdc"])!)).toBeLessThanOrEqual(128*1024);
      const result=cloudInstructionFiles(root,Array.from({length:100},()=>"AGENTS.md"))!;
      expect(Buffer.byteLength(result)).toBeLessThan(129*1024);expect(result.split("Repository instructions").length).toBe(2);
    }finally{await rm(root,{recursive:true,force:true});}
  });
});
