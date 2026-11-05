import {invitationResponseHeaders,invitationPageShell} from "./invite-page.mjs";
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Stable, authenticated workspace locator. Capability fragments never enter
 * SSR, access logs, OAuth state, return URLs, or referrers. Each state names
 * itself in the title and one line (the Zeros Design Web app frames). */
export function renderWorkspacePage({workspaceId,invitation=false,nonce}) {
  if(!UUID.test(workspaceId)||!/^[A-Za-z0-9_-]{8,128}$/.test(nonce))throw new TypeError("Invalid workspace page identity");
  workspaceId=workspaceId.toLowerCase();
  const path=`/workspace/${workspaceId}${invitation?"/invite":""}`;
  const script=`
    const WORKSPACE=${JSON.stringify(workspaceId)},INVITATION=${JSON.stringify(invitation)},PATH=${JSON.stringify(path)};
    const KEY="zeros:workspace-invitation:"+WORKSPACE;
    const AUTH_KEY="zeros:workspace-lookup-auth";
    const title=document.getElementById("title"),sub=document.getElementById("sub"),message=document.getElementById("message");
    const proceed=document.getElementById("proceed"),another=document.getElementById("another"),meta=document.getElementById("meta");
    const auth="/auth/start?return="+encodeURIComponent(PATH),logout="/auth/logout?return="+encodeURIComponent(PATH);
    another.href=logout;
    let pending=null,busy=false;
    const TOKEN=/^zwi_[A-Za-z0-9_-]{43}$/;
    const INVITE_LINE="Accept with the email this invite was sent to.";
    function show(view){
      if(view.title!==undefined)title.textContent=view.title;
      if(view.sub!==undefined)sub.textContent=view.sub;
      message.textContent=view.status||"";message.className=view.error?"msg error":"msg";
      if(view.action){proceed.textContent=view.action;proceed.className=view.quiet?"btn ghost":"btn";proceed.classList.remove("hidden");}
      else proceed.classList.add("hidden");
      if(view.another){another.className=view.action?"btn ghost":"btn";another.classList.remove("hidden");}
      else another.classList.add("hidden");
      if(view.meta)meta.classList.remove("hidden");else meta.classList.add("hidden");
    }
    function unavailable(line,withAnother=false){
      if(INVITATION){show({sub:line,status:"",another:true});return;}
      show({title:"Workspace unavailable",sub:line,action:"Try again",another:withAnother});
    }
    function inviteProblem(line){show({sub:INVITE_LINE,status:line,error:true,action:"Accept invitation"});}
    function save(){try{sessionStorage.setItem(KEY,JSON.stringify(pending));return sessionStorage.getItem(KEY)===JSON.stringify(pending);}catch{return false;}}
    function forget(){try{sessionStorage.removeItem(KEY);}catch{}pending=null;}
    if(INVITATION){
      try{pending=JSON.parse(sessionStorage.getItem(KEY)||"null");}catch{}
      const fragment=new URLSearchParams(window.location.hash.slice(1));
      if(window.location.hash){
        history.replaceState(null,"",PATH);
        // An invalid new link must not silently reuse a previously stored invite.
        forget();
        if(fragment.size===1&&fragment.getAll("token").length===1&&TOKEN.test(fragment.get("token")||"")){
          pending={token:fragment.get("token"),createdAt:Date.now(),authAttempted:false};save();
        }
      }
      if(!pending||!TOKEN.test(pending.token||"")||!Number.isFinite(pending.createdAt)||pending.createdAt>Date.now()+60000||Date.now()-pending.createdAt>7*86400000){
        forget();inviteProblem("Open the original invitation email to continue.");proceed.disabled=true;
      }
    }
    async function perform(){
      if(busy)return;busy=true;proceed.disabled=true;another.classList.add("hidden");
      try{
        if(INVITATION&&!pending)return;
        if(INVITATION)show({sub:INVITE_LINE,status:"Checking your invitation…",action:"Accept invitation"});
        else show({title:"Cloud workspace",sub:"Loading your cloud workspace. This takes a moment."});
        const response=await fetch(INVITATION?"/api/v1/cloud-workspace-invitations/accept":"/api/v1/cloud-workspaces/"+WORKSPACE,
          INVITATION?{method:"POST",credentials:"same-origin",headers:{"Content-Type":"application/json","X-Zeros-Request":"dashboard"},body:JSON.stringify({token:pending.token,workspaceId:WORKSPACE})}
            :{credentials:"same-origin",headers:{accept:"application/json"}});
        if(response.status===401){
          if(INVITATION){
            if(pending.authAttempted){unavailable("Sign-in didn’t create a session. Use the invited email.");return;}
            pending.authAttempted=true;
            if(!save()){inviteProblem("Allow tab storage, then reopen the invitation email.");return;}
          }else{
            try{
              const attempt=JSON.parse(sessionStorage.getItem(AUTH_KEY)||"null");
              if(attempt?.workspace===WORKSPACE&&Number.isFinite(attempt.createdAt)&&attempt.createdAt<=Date.now()+60000&&Date.now()-attempt.createdAt<600000){
                unavailable("Sign-in didn’t create a session. Allow cookies and retry.",true);return;
              }
              const next=JSON.stringify({workspace:WORKSPACE,createdAt:Date.now()});
              sessionStorage.setItem(AUTH_KEY,next);
              if(sessionStorage.getItem(AUTH_KEY)!==next)throw new Error("storage unavailable");
            }catch{unavailable("Allow tab storage to sign in to this workspace.");return;}
          }
          window.location.replace(auth);return;
        }
        const result=await response.json().catch(()=>null);
        if(response.ok){
          if(INVITATION){
            if(result?.workspaceId!==WORKSPACE){forget();inviteProblem("This invite is for another workspace. Use its email link.");return;}
            forget();window.location.replace("/workspace/"+WORKSPACE);return;
          }
          if(result?.workspace?.id!==WORKSPACE){unavailable("This link doesn’t match an available workspace.");return;}
          try{sessionStorage.removeItem(AUTH_KEY);}catch{}
          show({title:result.workspace.displayName||"Cloud workspace",sub:"You have access to this workspace on every device.",action:"Refresh",quiet:true,meta:true});
          return;
        }
        if(response.status===404||response.status===403){
          unavailable(INVITATION?"This invite expired or is for another email. Ask for a new one.":"This account can’t open this workspace. Try another account.",true);
          return;
        }
        if(INVITATION)inviteProblem("Zeros is unavailable right now. Try again shortly.");
        else unavailable("Zeros is unavailable right now. Try again shortly.");
      }catch{
        if(INVITATION)inviteProblem("Zeros is unreachable right now. Try again shortly.");
        else unavailable("Zeros is unreachable right now. Try again shortly.");
      }
      finally{busy=false;proceed.disabled=INVITATION&&!pending;}
    }
    proceed.addEventListener("click",perform);
    another.addEventListener("click",()=>{if(pending){pending.authAttempted=false;save();}try{sessionStorage.removeItem(AUTH_KEY);}catch{}});
    if(!INVITATION)perform();
  `;
  const inner=`<div class="title" id="title">${invitation?"Join a cloud workspace":"Cloud workspace"}</div>
    <div class="sub" id="sub">${invitation?"Accept with the email this invite was sent to.":"Loading your cloud workspace. This takes a moment."}</div>
    <div class="acts">
      <button class="btn${invitation?"":" hidden"}" id="proceed" type="button">${invitation?"Accept invitation":"Refresh"}</button>
      <a class="btn ghost hidden" id="another">Use another account</a>
    </div>
    <div class="msg" id="message" aria-live="polite"></div>
    <p class="meta hidden" id="meta">Cloud workspace · same identity on every device</p>
    <script nonce="${nonce}">${script}</script>`;
  return {html:invitationPageShell("Zeros — cloud workspace",inner,nonce),headers:invitationResponseHeaders(nonce)};
}
