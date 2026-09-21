import {invitationResponseHeaders,invitationPageShell} from "./invite-page.mjs";
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Stable, authenticated workspace locator. Capability fragments never enter
 * SSR, access logs, OAuth state, return URLs, or referrers. */
export function renderWorkspacePage({workspaceId,invitation=false,nonce}) {
  if(!UUID.test(workspaceId)||!/^[A-Za-z0-9_-]{8,128}$/.test(nonce))throw new TypeError("Invalid workspace page identity");
  workspaceId=workspaceId.toLowerCase();
  const path=`/workspace/${workspaceId}${invitation?"/invite":""}`;
  const script=`
    const WORKSPACE=${JSON.stringify(workspaceId)},INVITATION=${JSON.stringify(invitation)},PATH=${JSON.stringify(path)};
    const KEY="zeros:workspace-invitation:"+WORKSPACE;
    const AUTH_KEY="zeros:workspace-lookup-auth";
    const message=document.getElementById("message"),proceed=document.getElementById("proceed"),another=document.getElementById("another");
    const auth="/auth/start?return="+encodeURIComponent(PATH),logout="/auth/logout?return="+encodeURIComponent(PATH);
    another.href=logout;
    let pending=null,busy=false;
    const TOKEN=/^zwi_[A-Za-z0-9_-]{43}$/;
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
        forget();proceed.disabled=true;message.textContent="Open the original invitation email to continue.";
      }
    }
    async function perform(){
      if(busy)return;busy=true;proceed.disabled=true;another.classList.add("hidden");
      try{
        if(INVITATION&&!pending)return;
        message.textContent=INVITATION?"Checking your invitation…":"Loading workspace…";
        const response=await fetch(INVITATION?"/api/v1/cloud-workspace-invitations/accept":"/api/v1/cloud-workspaces/"+WORKSPACE,
          INVITATION?{method:"POST",credentials:"same-origin",headers:{"Content-Type":"application/json","X-Zeros-Request":"dashboard"},body:JSON.stringify({token:pending.token,workspaceId:WORKSPACE})}
            :{credentials:"same-origin",headers:{accept:"application/json"}});
        if(response.status===401){
          if(INVITATION){
            if(pending.authAttempted){message.textContent="Sign-in did not establish a session. Use the invited email address and try again.";another.classList.remove("hidden");return;}
            pending.authAttempted=true;
            if(!save()){message.textContent="Allow tab storage and reopen the invitation email to sign in.";return;}
          }else{
            try{
              const attempt=JSON.parse(sessionStorage.getItem(AUTH_KEY)||"null");
              if(attempt?.workspace===WORKSPACE&&Number.isFinite(attempt.createdAt)&&attempt.createdAt<=Date.now()+60000&&Date.now()-attempt.createdAt<600000){
                message.textContent="Sign-in did not establish a session. Allow cookies and try again.";another.classList.remove("hidden");return;
              }
              const next=JSON.stringify({workspace:WORKSPACE,createdAt:Date.now()});
              sessionStorage.setItem(AUTH_KEY,next);
              if(sessionStorage.getItem(AUTH_KEY)!==next)throw new Error("storage unavailable");
            }catch{message.textContent="Allow tab storage to sign in to this workspace.";return;}
          }
          window.location.replace(auth);return;
        }
        const result=await response.json().catch(()=>null);
        if(response.ok){
          if(INVITATION){
            if(result?.workspaceId!==WORKSPACE){forget();message.textContent="This invitation belongs to another workspace. Open its original email link.";return;}
            forget();window.location.replace("/workspace/"+WORKSPACE);return;
          }
          if(result?.workspace?.id!==WORKSPACE){message.textContent="Workspace is unavailable.";return;}
          try{sessionStorage.removeItem(AUTH_KEY);}catch{}
          document.getElementById("title").textContent=result.workspace.displayName||"Cloud workspace";
          message.textContent="You have access to this workspace. Status: "+String(result.workspace.status||"unknown")+".";
          proceed.textContent="Refresh";return;
        }
        if(response.status===404||response.status===403){
          message.textContent=INVITATION?"This invitation is unavailable for this account, expired, or revoked. Sign in with the invited email address or request a fresh invitation.":"This workspace is unavailable for your account.";
          another.classList.remove("hidden");return;
        }
        message.textContent="Zeros is temporarily unavailable. Try again shortly.";
      }catch{message.textContent="Zeros is temporarily unreachable. Try again shortly.";}
      finally{busy=false;proceed.disabled=INVITATION&&!pending;}
    }
    proceed.addEventListener("click",perform);
    another.addEventListener("click",()=>{if(pending){pending.authAttempted=false;save();}try{sessionStorage.removeItem(AUTH_KEY);}catch{}});
    if(!INVITATION)perform();
  `;
  const inner=`<div class="title" id="title">${invitation?"Join a cloud workspace":"Cloud workspace"}</div>
    <div class="sub">${invitation?"Accept this invitation using the email address it was sent to.":"Your workspace has the same identity on every device."}</div>
    <div class="msg" id="message" aria-live="polite"></div>
    <button class="btn" id="proceed" type="button">${invitation?"Accept invitation":"Refresh"}</button>
    <a class="btn secondary hidden" id="another">Use another account</a>
    <script nonce="${nonce}">${script}</script>`;
  return {html:invitationPageShell("Zeros — cloud workspace",inner,nonce),headers:invitationResponseHeaders(nonce)};
}
