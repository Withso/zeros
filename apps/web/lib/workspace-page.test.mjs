import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import {renderWorkspacePage} from "./workspace-page.mjs";
import {allowedControlPlaneRoute} from "./control-plane-policy.mjs";
const workspaceId="11111111-1111-4111-8111-111111111111",token=`zwi_${"A".repeat(43)}`;
function fixture({hash=`#token=${token}`,storage=new Map(),response={status:401},invitation=true}={}) {
  const page=renderWorkspacePage({workspaceId,invitation,nonce:"testnonce"}),elements=new Map(),replacements=[],history=[],requests=[];
  for(const id of ["title","message","proceed","another"])elements.set(id,{textContent:"",disabled:false,events:{},classList:{add(){},remove(){}},addEventListener(name,fn){this.events[name]=fn;}});
  const script=page.html.match(/<script nonce="testnonce">([\s\S]*?)<\/script>/)[1];
  vm.runInNewContext(script,{URLSearchParams,Date,document:{getElementById:id=>elements.get(id)},
    sessionStorage:{getItem:key=>storage.get(key)??null,setItem:(key,value)=>storage.set(key,value),removeItem:key=>storage.delete(key)},
    history:{replaceState:(_state,_title,value)=>history.push(value)},window:{location:{hash,replace:value=>replacements.push(value)}},
    fetch:async(url,options)=>{requests.push({url,options});return response;}});
  return {page,elements,replacements,history,requests,storage,click:()=>elements.get("proceed").events.click()};
}
test("workspace invitations keep bearers out of SSR and require an explicit same-origin acceptance",async()=>{
  const f=fixture({response:{status:200,ok:true,json:async()=>({workspaceId})}});
  assert.equal(f.requests.length,0);assert.deepEqual(f.history,[`/workspace/${workspaceId}/invite`]);
  assert.doesNotMatch(f.page.html,new RegExp(token));assert.equal(f.page.headers.get("referrer-policy"),"no-referrer");
  await f.click();assert.equal(f.requests[0].url,"/api/v1/cloud-workspace-invitations/accept");
  assert.deepEqual(JSON.parse(f.requests[0].options.body),{token,workspaceId});
  assert.equal(f.requests[0].options.headers["X-Zeros-Request"],"dashboard");
  assert.equal(f.storage.size,0);assert.deepEqual(f.replacements,[`/workspace/${workspaceId}`]);
});
test("authentication resumes only the exact tab invitation and does not loop",async()=>{
  const first=fixture();await first.click();
  assert.equal(first.replacements.length,1);assert.ok(!first.replacements[0].includes(token));
  const second=fixture({hash:"",storage:first.storage});await second.click();
  assert.equal(second.replacements.length,0);assert.match(second.elements.get("message").textContent,/Sign-in did not establish/);
});
test("ordinary workspace lookup bounds automatic auth redirects and permits explicit retry",async()=>{
  const first=fixture({invitation:false,hash:""});await new Promise(resolve=>setImmediate(resolve));
  assert.equal(first.replacements.length,1);
  const second=fixture({invitation:false,hash:"",storage:first.storage});await new Promise(resolve=>setImmediate(resolve));
  assert.equal(second.replacements.length,0);assert.match(second.elements.get("message").textContent,/Sign-in did not establish/);
  second.elements.get("another").events.click();
  const retry=fixture({invitation:false,hash:"",storage:second.storage});await new Promise(resolve=>setImmediate(resolve));
  assert.equal(retry.replacements.length,1);
});
test("ambiguous fragments erase earlier invites and cannot trigger acceptance",()=>{
  const first=fixture();
  const second=fixture({hash:`#token=${token}&token=${token}`,storage:first.storage});
  assert.equal(second.elements.get("proceed").disabled,true);assert.equal(second.storage.size,0);assert.equal(second.requests.length,0);
});
test("the browser proxy admits only exact workspace lookup and invitation acceptance routes",()=>{
  assert.equal(allowedControlPlaneRoute("POST","/v1/cloud-workspace-invitations/accept"),true);
  assert.equal(allowedControlPlaneRoute("GET",`/v1/cloud-workspaces/${workspaceId}`),true);
  assert.equal(allowedControlPlaneRoute("POST",`/v1/cloud-workspaces/${workspaceId}/invitations`),false);
  assert.equal(allowedControlPlaneRoute("GET",`/v1/cloud-workspaces/${workspaceId}/private`),false);
  assert.equal(allowedControlPlaneRoute("DELETE",`/v1/cloud-workspaces/${workspaceId}`),false);
});
