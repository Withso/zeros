import {invitationResponseHeaders,invitationPageShell} from "./invite-page.mjs";
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const APP_LINK=/^zeros(?:-alpha|-beta|-dev)?:\/\/$/;
const OWNER=/^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/;
const NUMBER=/^[1-9][0-9]{0,9}$/;
/** Owner segments no organization's page uses (web routes, Local, link
 * actions). Mirrors @zeros/protocol RESERVED_WORKSPACE_LINK_OWNERS; the root
 * parity test keeps them equal. */
export const RESERVED_WORKSPACE_PAGE_OWNERS=Object.freeze(["agents","api","assets","auth","chat","cloud-workspace","github","invite","local","open","personal","schemas","w","workspace"]);

/** `/<organization slug>/w/<n>` → its address, or null. The exact grammar of
 * @zeros/protocol parseCloudWorkspacePagePath (apps/web cannot import it). */
export function parseWorkspacePagePath(pathname) {
  const match=/^\/([A-Za-z0-9-]{1,100})\/w\/([1-9][0-9]{0,9})$/.exec(String(pathname));
  if(!match)return null;
  const owner=match[1].toLowerCase(),number=Number(match[2]);
  return OWNER.test(owner)&&!RESERVED_WORKSPACE_PAGE_OWNERS.includes(owner)&&number<=2147483647?{owner,number}:null;
}

/** A cloud workspace's page for its creator: the control plane's exact v2 read
 * (creator-only, current members) by id or by its shareable address
 * `<organization slug>/w/<n>`, then Open in Zeros through
 * `<scheme>://cloud-workspace/<organizationId>/<workspaceId>`, the link every
 * desktop app opens (packages/protocol/src/cloud-workspace-link.ts). Each state
 * names itself in the title and one line (the Zeros Design Web app frames). */
export function renderWorkspacePage({workspaceId,address,appLink,nonce}) {
  const numbered=address!==undefined;
  if((numbered?!(address&&OWNER.test(address.owner)&&!RESERVED_WORKSPACE_PAGE_OWNERS.includes(address.owner)&&Number.isSafeInteger(address.number)&&NUMBER.test(String(address.number))&&address.number<=2147483647):!UUID.test(workspaceId))||
    !APP_LINK.test(appLink)||!/^[A-Za-z0-9_-]{8,128}$/.test(nonce))throw new TypeError("Invalid workspace page identity");
  workspaceId=numbered?null:workspaceId.toLowerCase();
  const path=numbered?`/${address.owner}/w/${address.number}`:`/workspace/${workspaceId}`;
  const read=numbered?`/api/v1/cloud-v2/workspaces/by-number/${address.owner}/${address.number}`:`/api/v1/cloud-v2/workspaces/${workspaceId}`;
  const script=`
    const WORKSPACE=${JSON.stringify(workspaceId)},NUMBER=${JSON.stringify(numbered?address.number:null)},PATH=${JSON.stringify(path)},READ=${JSON.stringify(read)},APP=${JSON.stringify(appLink)};
    const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    const AUTH_KEY="zeros:workspace-lookup-auth";
    const title=document.getElementById("title"),sub=document.getElementById("sub"),spin=document.getElementById("spin");
    const open=document.getElementById("open"),proceed=document.getElementById("proceed"),another=document.getElementById("another"),meta=document.getElementById("meta");
    const auth="/auth/start?return="+encodeURIComponent(PATH),logout="/auth/logout?return="+encodeURIComponent(PATH);
    another.href=logout;
    let busy=false;
    function show(view){
      title.textContent=view.title;sub.textContent=view.sub;
      if(view.loading)spin.classList.remove("hidden");else spin.classList.add("hidden");
      if(view.open){open.href=view.open;open.classList.remove("hidden");}
      else{open.removeAttribute("href");open.classList.add("hidden");}
      if(view.action){proceed.textContent=view.action;proceed.className=view.open?"btn ghost":"btn";proceed.classList.remove("hidden");}
      else proceed.classList.add("hidden");
      if(view.another){another.className="btn ghost";another.classList.remove("hidden");}
      else another.classList.add("hidden");
      if(view.meta)meta.classList.remove("hidden");else meta.classList.add("hidden");
    }
    function unavailable(line,withAnother=false){
      show({title:"Workspace unavailable",sub:line,action:"Try again",another:withAnother});
    }
    async function perform(){
      if(busy)return;busy=true;proceed.disabled=true;
      try{
        show({title:"Cloud workspace",sub:"Loading your cloud workspace. This takes a moment.",loading:true});
        const response=await fetch(READ,{credentials:"same-origin",headers:{accept:"application/json"}});
        if(response.status===401){
          try{
            const attempt=JSON.parse(sessionStorage.getItem(AUTH_KEY)||"null");
            if(attempt?.workspace===PATH&&Number.isFinite(attempt.createdAt)&&attempt.createdAt<=Date.now()+60000&&Date.now()-attempt.createdAt<600000){
              unavailable("Sign-in didn’t create a session. Allow cookies and retry.",true);return;
            }
            const next=JSON.stringify({workspace:PATH,createdAt:Date.now()});
            sessionStorage.setItem(AUTH_KEY,next);
            if(sessionStorage.getItem(AUTH_KEY)!==next)throw new Error("storage unavailable");
          }catch{unavailable("Allow tab storage to sign in to this workspace.");return;}
          window.location.replace(auth);return;
        }
        const result=await response.json().catch(()=>null);
        if(response.ok){
          const workspace=result?.workspace;
          if(typeof workspace?.id!=="string"||!UUID.test(workspace.id)||(WORKSPACE?workspace.id!==WORKSPACE:workspace.number!==NUMBER)||
            typeof workspace.organizationId!=="string"||!UUID.test(workspace.organizationId)){
            unavailable("This link doesn’t match an available workspace.");return;
          }
          try{sessionStorage.removeItem(AUTH_KEY);}catch{}
          // Its first chat's name; "Untitled" until then. An older control
          // plane sends no title and keeps the workspace's name.
          const name=typeof workspace.title==="string"&&workspace.title.trim()?workspace.title.trim()
            :workspace.title===null?"Untitled":typeof workspace.name==="string"?workspace.name.trim():"";
          const number=Number.isSafeInteger(workspace.number)&&workspace.number>0?"w-"+workspace.number+" · ":"";
          meta.textContent=number+"Cloud workspace · same identity on every device";
          show({title:name||"Cloud workspace",sub:"You have access to this workspace on every device.",
            open:APP+"cloud-workspace/"+workspace.organizationId.toLowerCase()+"/"+workspace.id.toLowerCase(),action:"Refresh",meta:true});
          return;
        }
        if(response.status===404||response.status===403){
          unavailable("This account can’t open this workspace. Try another account.",true);
          return;
        }
        unavailable("Zeros is unavailable right now. Try again shortly.");
      }catch{
        unavailable("Zeros is unreachable right now. Try again shortly.");
      }
      finally{busy=false;proceed.disabled=false;}
    }
    proceed.addEventListener("click",perform);
    another.addEventListener("click",()=>{try{sessionStorage.removeItem(AUTH_KEY);}catch{}});
    perform();
  `;
  const inner=`<div class="title" id="title">Cloud workspace</div>
    <div class="sub" id="sub">Loading your cloud workspace. This takes a moment.</div>
    <div class="spin" id="spin"><span class="orb" aria-hidden="true"></span></div>
    <div class="acts">
      <a class="btn hidden" id="open">Open in Zeros</a>
      <button class="btn hidden" id="proceed" type="button">Refresh</button>
      <a class="btn ghost hidden" id="another">Use another account</a>
    </div>
    <p class="meta hidden" id="meta">Cloud workspace · same identity on every device</p>
    <script nonce="${nonce}">${script}</script>`;
  return {html:invitationPageShell("Zeros — cloud workspace",inner,nonce),headers:invitationResponseHeaders(nonce)};
}
