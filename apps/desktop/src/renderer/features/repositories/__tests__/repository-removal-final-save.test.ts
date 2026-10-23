import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";

// Execute the real handler with its product dependencies replaced. Rendering
// the surrounding settings forms is unrelated to the destructive continuation.
const file=ts.createSourceFile("repositories-panel.tsx",readFileSync(
  new URL("../repositories-panel.tsx",import.meta.url),"utf8"),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
let handler:ts.Expression|undefined;
const visit=(node:ts.Node)=>{
  if(ts.isVariableDeclaration(node)&&node.name.getText(file)==="handleRemove")handler=node.initializer;
  ts.forEachChild(node,visit);
};
visit(file);
if(!handler)throw new Error("Repository removal handler missing");
const code=ts.transpileModule(`(${handler.getText(file)})`,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;

function fixture(result:unknown){
  const project={id:"repository-fixture",repoRoot:"/repo",repoSlug:"fixture",name:"Fixture"};
  const workspace={id:"cloud://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222",path:"/repo/worktree",branch:"work"};
  const effects=Object.fromEntries(["setBusy","dispatch","onOpenChange","removeProject","clearRepoPerformanceSnapshots",
    "clearChangesFilters","forgetChangesSnapshots","forgetReviewCachesForFolders","forgetPrCachesForWorkspace",
    "clearTerminalFolders","clearChatPaneFolders","clearDashboardRepoFilter","forgetRepositoryVisibility",
    "forgetRepositoryCollapsed","forgetWorkspacesFor","clearRepoSettings","notifyProjectsChanged","notifyWorkspacesChanged",
    "dbDeleteChat","setSetting"].map(name=>[name,vi.fn()]));
  const toast={success:vi.fn(),warning:vi.fn(),error:vi.fn()};
  const workspaceDelete=vi.fn().mockResolvedValue(result);
  const scope={...effects,busy:false,project,chats:[],activeChatId:null,newAgentFolder:null,
    projects:[project,{id:"other",repoRoot:"/other"}],peekWorkspacesFor:()=>[workspace],workspaceList:async()=>[workspace],
    folderIsOwnedByProject:()=>true,isLocalMainWorkspace:()=>false,workspaceDelete,
    toast,isGitErrorShape:()=>false,console:{warn:vi.fn(),error:vi.fn()}};
  const run=new Function(...Object.keys(scope),`return ${code}`)(...Object.values(scope)) as ()=>Promise<void>;
  return {run,effects,toast,workspaceDelete};
}

describe("repository removal final-save continuation",()=>{
  it("retains the completed Local/organization-local deletion continuation",async()=>{
    const f=fixture(undefined);await f.run();
    expect(f.workspaceDelete).toHaveBeenCalledOnce();
    expect(f.effects.removeProject).toHaveBeenCalledExactlyOnceWith("repository-fixture");
    expect(f.toast.success).toHaveBeenCalledOnce();
    expect(f.toast.error).not.toHaveBeenCalled();
  });
});
