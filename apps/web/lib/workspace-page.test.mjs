import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import {renderWorkspacePage} from "./workspace-page.mjs";
import {allowedControlPlaneRoute} from "./control-plane-policy.mjs";
const workspaceId="11111111-1111-4111-8111-111111111111",organizationId="5d2f8c1a-3b7e-4f90-a6d4-9c1e2b7f8a35";
const IDS=["title","sub","open","proceed","another","meta"];
const ok=(workspace)=>({status:200,ok:true,json:async()=>({workspace})});
const ready={id:workspaceId,organizationId,name:"Acme API",state:"stopped",placement:"cloud",version:2};
function fixture({storage=new Map(),response={status:401},appLink="zeros-alpha://"}={}) {
  const page=renderWorkspacePage({workspaceId,appLink,nonce:"testnonce"}),elements=new Map(),replacements=[],requests=[];
  for(const id of IDS){const hidden=new Set(["hidden"]);elements.set(id,{textContent:"",className:"",href:"",disabled:false,events:{},hidden,classList:{add(name){hidden.add(name);},remove(name){hidden.delete(name);},contains(name){return hidden.has(name);}},removeAttribute(name){if(name==="href")this.href="";},addEventListener(name,fn){this.events[name]=fn;}});}
  const script=page.html.match(/<script nonce="testnonce">([\s\S]*?)<\/script>/)[1];
  vm.runInNewContext(script,{Date,document:{getElementById:id=>elements.get(id)},
    sessionStorage:{getItem:key=>storage.get(key)??null,setItem:(key,value)=>storage.set(key,value),removeItem:key=>storage.delete(key)},
    window:{location:{replace:value=>replacements.push(value)}},
    fetch:async(url,options)=>{requests.push({url,options});return response;}});
  const shown=id=>!elements.get(id).classList.contains("hidden");
  return {page,elements,replacements,requests,storage,shown,settle:()=>new Promise(resolve=>setImmediate(resolve))};
}

test("the creator sees the workspace by name, with Open in Zeros for this deployment's app",async()=>{
  const f=fixture({response:ok(ready)});await f.settle();
  assert.equal(f.requests.length,1);
  assert.equal(f.requests[0].url,`/api/v1/cloud-v2/workspaces/${workspaceId}`);
  assert.equal(f.requests[0].options.credentials,"same-origin");
  assert.equal(f.elements.get("title").textContent,"Acme API");
  assert.equal(f.elements.get("sub").textContent,"You have access to this workspace on every device.");
  assert.equal(f.shown("open"),true);
  assert.equal(f.elements.get("open").href,`zeros-alpha://cloud-workspace/${organizationId}/${workspaceId}`);
  assert.equal(f.elements.get("proceed").textContent,"Refresh");
  assert.equal(f.elements.get("proceed").className,"btn ghost");
  assert.equal(f.shown("another"),false);
  assert.equal(f.shown("meta"),true);
});

test("each deployment opens its own app, and an unnamed workspace keeps the plain title",async()=>{
  const f=fixture({appLink:"zeros://",response:ok({...ready,name:"",organizationId:organizationId.toUpperCase()})});await f.settle();
  assert.equal(f.elements.get("title").textContent,"Cloud workspace");
  assert.equal(f.elements.get("open").href,`zeros://cloud-workspace/${organizationId}/${workspaceId}`);
  for(const appLink of ["javascript:","https://","zeros-prod://","zeros"]) assert.throws(()=>renderWorkspacePage({workspaceId,appLink,nonce:"testnonce"}));
});

test("a response for another workspace, or without its organization, opens nothing",async()=>{
  for(const workspace of [{...ready,id:"22222222-2222-4222-8222-222222222222"},{...ready,organizationId:"../ops"},{...ready,organizationId:undefined}]){
    const f=fixture({response:ok(workspace)});await f.settle();
    assert.equal(f.elements.get("title").textContent,"Workspace unavailable");
    assert.equal(f.elements.get("sub").textContent,"This link doesn’t match an available workspace.");
    assert.equal(f.shown("open"),false);
    assert.equal(f.elements.get("open").href,"");
  }
});

test("an account that can't open it is told so, with another account",async()=>{
  for(const status of [403,404]){
    const f=fixture({response:{status,ok:false,json:async()=>null}});await f.settle();
    assert.equal(f.elements.get("title").textContent,"Workspace unavailable");
    assert.equal(f.elements.get("sub").textContent,"This account can’t open this workspace. Try another account.");
    assert.equal(f.elements.get("proceed").textContent,"Try again");
    assert.equal(f.shown("another"),true);
    assert.equal(f.shown("open"),false);
  }
  const down=fixture({response:{status:503,ok:false,json:async()=>null}});await down.settle();
  assert.equal(down.elements.get("sub").textContent,"Zeros is unavailable right now. Try again shortly.");
  assert.equal(down.shown("another"),false);
});

test("sign-in redirects once, then offers a retry instead of looping",async()=>{
  const first=fixture();await first.settle();
  assert.deepEqual(first.replacements,[`/auth/start?return=${encodeURIComponent(`/workspace/${workspaceId}`)}`]);
  const second=fixture({storage:first.storage});await second.settle();
  assert.equal(second.replacements.length,0);assert.equal(second.elements.get("title").textContent,"Workspace unavailable");
  assert.equal(second.elements.get("sub").textContent,"Sign-in didn’t create a session. Allow cookies and retry.");
  assert.equal(second.elements.get("proceed").textContent,"Try again");
  assert.equal(second.elements.get("another").href,`/auth/logout?return=${encodeURIComponent(`/workspace/${workspaceId}`)}`);
  second.elements.get("another").events.click();
  const retry=fixture({storage:second.storage});await retry.settle();
  assert.equal(retry.replacements.length,1);
  const blocked=fixture({storage:{get:()=>null,set(){throw new Error("blocked");},delete(){}}});await blocked.settle();
  assert.equal(blocked.elements.get("sub").textContent,"Allow tab storage to sign in to this workspace.");
});

test("the page starts in its loading state and carries no invitation flow",()=>{
  const {html}=renderWorkspacePage({workspaceId:workspaceId.toUpperCase(),appLink:"zeros-beta://",nonce:"testnonce"});
  assert.match(html,/<div class="title" id="title">Cloud workspace<\/div>/);
  assert.match(html,/<div class="sub" id="sub">Loading your cloud workspace\. This takes a moment\.<\/div>/);
  assert.match(html,/<a class="btn hidden" id="open">Open in Zeros<\/a>/);
  assert.match(html,new RegExp(`/workspace/${workspaceId}`));
  assert.doesNotMatch(html,/invitation|invite|zwi_|\/v1\/cloud-workspaces\//i);
  assert.equal(existsSync(new URL("../functions/workspace/[workspace]/invite.ts",import.meta.url)),false);
});

test("the browser proxy admits only the exact v2 workspace read",()=>{
  assert.equal(allowedControlPlaneRoute("GET",`/v1/cloud-v2/workspaces/${workspaceId}`),true);
  assert.equal(allowedControlPlaneRoute("GET","/v1/cloud-v2/workspaces"),false);
  assert.equal(allowedControlPlaneRoute("GET",`/v1/cloud-v2/workspaces/${workspaceId}/history`),false);
  assert.equal(allowedControlPlaneRoute("POST",`/v1/cloud-v2/workspaces/${workspaceId}/connect`),false);
  assert.equal(allowedControlPlaneRoute("POST",`/v1/cloud-v2/workspaces/${workspaceId}/start`),false);
  assert.equal(allowedControlPlaneRoute("DELETE",`/v1/cloud-v2/workspaces/${workspaceId}`),false);
  assert.equal(allowedControlPlaneRoute("GET",`/v1/cloud-workspaces/${workspaceId}`),false);
  assert.equal(allowedControlPlaneRoute("POST","/v1/cloud-workspace-invitations/accept"),false);
});
