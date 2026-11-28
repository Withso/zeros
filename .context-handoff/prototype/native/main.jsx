import React,{useState,useEffect,useRef} from 'react';
import {createRoot} from 'react-dom/client';
import {Button} from '@/renderer/shared/ui/primitives/button';
import {ListRow} from '@/renderer/shared/ui/primitives/list-row';
import {Avatar,AvatarFallback} from '@/renderer/shared/ui/primitives/avatar';
import {Badge} from '@/renderer/shared/ui/primitives/badge';
import {Tabs,TabsList,TabsTrigger} from '@/renderer/shared/ui/primitives/tabs';
import {Sheet,SheetContent,SheetTitle} from '@/renderer/shared/ui/primitives/sheet';
import {Select,SelectTrigger,SelectContent,SelectItem,SelectValue} from '@/renderer/shared/ui/primitives/select';
import {Checkbox} from '@/renderer/shared/ui/primitives/checkbox';
import {Input} from '@/renderer/shared/ui/primitives/input';
import {SettingsRow,SettingsSection} from '@/renderer/features/settings/settings-ui';
import {Switch} from '@/renderer/shared/ui/primitives/switch';
import {DropdownMenu,DropdownMenuTrigger,DropdownMenuContent,DropdownMenuCheckboxItem,DropdownMenuSeparator,DropdownMenuItem} from '@/renderer/shared/ui/primitives/dropdown-menu';
import {Ellipsis, KeyRound, Terminal, Trash2, ArrowLeft, ArrowUpRight, Link, Building2, Lock, UserRound, UsersRound, Cloud, Laptop, BookMarked, Folder, ChevronRight, Plus, X, ShieldCheck, BookOpen, RefreshCw, GitBranch, Search, ChevronDown, Check, Sun, Moon, SlidersHorizontal} from 'lucide-react';
import logo from '/Users/devin/repos/zeros/apps/marketing/public/zeros-logo.svg?raw';
import './theme.css';
const ExternalLink=({children,...attrs})=><a {...attrs}>{children}</a>;
const PageLayout=React.Fragment;

function GitHubMark({size=22}){return <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="currentColor"><path d="M10.226 17.284c-2.965-.36-5.054-2.493-5.054-5.256 0-1.123.404-2.336 1.078-3.144-.292-.741-.247-2.314.09-2.965.898-.112 2.111.36 2.83 1.01.853-.269 1.752-.404 2.853-.404 1.1 0 1.999.135 2.807.382.696-.629 1.932-1.1 2.83-.988.315.606.36 2.179.067 2.942.72.854 1.101 2 1.101 3.167 0 2.763-2.089 4.852-5.098 5.234.763.494 1.28 1.572 1.28 2.807v2.336c0 .674.561 1.056 1.235.786 4.066-1.55 7.255-5.615 7.255-10.646C23.5 6.188 18.334 1 11.978 1 5.62 1 .5 6.188.5 12.545c0 4.986 3.167 9.12 7.435 10.669.606.225 1.19-.18 1.19-.786V20.63a2.9 2.9 0 0 1-1.078.224c-1.483 0-2.359-.808-2.987-2.313-.247-.607-.517-.966-1.034-1.033-.27-.023-.359-.135-.359-.27 0-.27.45-.471.898-.471.652 0 1.213.404 1.797 1.235.45.651.921.943 1.483.943.561 0 .92-.202 1.437-.719.382-.381.674-.718.944-.943"/></svg>}

const people = {
  arun:{name:"Arun",login:"iamarunrk",initials:"AR",role:"Admin"},
  maya:{name:"Maya",login:"maya-dev",initials:"MK",role:"Member"},
  sam:{name:"Sam",login:null,initials:"SA",role:"Member"}
};
const catalog = {
  Withso:[["zeros",true,"write","write"],["0colors",true,"write","read"],["0docs",true,"write","read"],["withso-website",true,"write","read"],["zeros-design-demo",true,"write","read"],["design-system",false,"write","read"],["infrastructure",false,"write","write"],["release-tools",false,"write",null]],
  iamarunrk:[["portfolio",true,"write","read"],["field-notes",false,"write","write"],["0kit",false,"write",null],["zeros-archive",false,"write",null]],
  "arun-labs":[["type-study",false,"write",null]],
  "maya-dev":[["sketchbook",false,null,"write"],["components",true,"read","write"]],
  Northstar:[["dashboard",false,"write",null]],
  "Studio-Labs":[["patterns",true,"write","read"]]
};
const isPublic = repo => {const [owner,name]=repo.split("/");return catalog[owner]?.find(r=>r[0]===name)?.[1]};
const organizationInstallations = new Set(["Withso","Studio-Labs","Northstar"]);
const Preview=React.createContext({});
const seedConnections = [
  {id:"withso",owner:"Withso",scope:"org",repos:{"Withso/0colors":"all","Withso/0docs":"all","Withso/zeros":"all","Withso/withso-website":"all","Withso/zeros-design-demo":"all","Withso/design-system":"all","Withso/infrastructure":"arun"}},
  {id:"arun-private",owner:"iamarunrk",scope:"arun",repos:{"iamarunrk/portfolio":"arun","iamarunrk/0kit":"arun","iamarunrk/field-notes":"arun"}}
];
const seedProjects = [
  {id:"zeros",name:"Zeros",scope:"org",repos:["Withso/zeros"]},
  {id:"site",name:"Personal website",scope:"arun",repos:["iamarunrk/portfolio"]}
];
const mkId=()=>Math.random().toString(36).slice(2);
const admin = user => ["Owner","Admin"].includes(people[user]?.role);

const owns = (c,user) => c.scope===user || (c.scope==="org"&&admin(user));
const AccessModel=React.createContext(null);
function accountIsLinked(c,user,identity){
 const login=identity?.cloudLogin;
 return !!login && (c.linked?.[user]||[people[user].login]).includes(login) && authorizedFor(login,c.owner);
}
function buildAccessModel(identities,installs,later,solo){
  const linkedMembers=Object.keys(people).filter(id=>(!solo||id==="arun")&&identities[id]?.cloud);
  const access=(repo,user)=>{
    if(!identities[user]?.cloud)return null;
    const [owner,name]=repo.split("/");
    if(identities[user]?.cloudLogin?.endsWith("-withso")&&owner!=="Withso")return null;
    return catalog[owner]?.find(r=>r[0]===name)?.[user==="arun"?2:3]||null;
  };
const hasLink=(c,user)=>accountIsLinked(c,user,identities[user]);
const eligible = (c,repo,user) => hasLink(c,user) && (!later||Object.hasOwn(c.repos,repo)) && installs[c.owner]?.includes(repo) && !!access(repo,user) && (c.scope===user || (c.scope==="org" && (!later||["all",user].includes(c.repos[repo]))));
const permitted = (cs,user,sharedOnly=false) => [...new Set(cs.filter(c=>!sharedOnly||c.scope==="org").flatMap(c=>(later?Object.keys(c.repos):installs[c.owner]||[]).filter(r=>eligible(c,r,user))))];
const canSeeProject = (p,user,cs) => p.scope===user || (p.scope==="org" && (!later||p.repos.every(r=>permitted(cs,user,true).includes(r))));
return {access,hasLink,eligible,permitted,canSeeProject,linkedMembers}
}
const audienceName = v => v==="all"?"All Withso members":v==="arun"?"Arun only":"Maya only";
const names = {connections:"Connections",projects:"Projects"};
const icons={link:Link,org:Building2,lock:Lock,person:UserRound,group:UsersRound,cloud:Cloud,mac:Laptop,repo:BookMarked,folder:Folder,chev:ChevronRight,plus:Plus,close:X,shield:ShieldCheck,book:BookOpen,refresh:RefreshCw,branch:GitBranch,search:Search,down:ChevronDown,check:Check};
function G({n,size=14}){const Icon=icons[n];return <Icon width={size} height={size} strokeWidth={1.5} aria-hidden/>}
function Scope({scope}){return <Badge variant={scope==="org"?"neutral":"merged"}><G n={scope==="org"?"group":"lock"} size={12}/>{scope==="org"?"Organization":"Only you"}</Badge>}
function Heading({title,desc,children}){return <SettingsSection title={title} description={desc} action={children}/>}
function Row({title,hint,children,leading}){return <SettingsRow label={title} hint={hint} leading={leading}>{children}</SettingsRow>}
function Seg({value,items,set,label="Options"}){return <Tabs value={value} onValueChange={set}><TabsList variant="chrome" aria-label={label}>{items.map(([v,t])=><TabsTrigger key={v} variant="chrome" value={v}>{t}</TabsTrigger>)}</TabsList></Tabs>}
function Picker({label,value,items,set,disabled=false,quiet=false}){return <Select value={value} onValueChange={set} disabled={disabled}><SelectTrigger aria-label={label} size={quiet?"compact":"default"} className={quiet?"border-transparent text-fg2 hover:border-transparent data-[state=open]:border-transparent":undefined}><SelectValue/></SelectTrigger><SelectContent>{items.map(([v,t])=><SelectItem key={v} value={v}>{t}</SelectItem>)}</SelectContent></Select>}
function CheckList({items,chosen,set}){return <div className="inventory">{items.length?items.map(r=><label key={r} className="selection-row"><Checkbox aria-label={r} checked={chosen.includes(r)} onChange={()=>set(chosen.includes(r)?chosen.filter(x=>x!==r):[...chosen,r])}/><span className="grow">{r}</span><Badge>{isPublic(r)?"Public":"Private"}</Badge></label>):<p className="empty">No eligible repositories.</p>}</div>}
function Drawer({label,close,children}){const trigger=useRef(document.activeElement);return <Sheet open onOpenChange={v=>{if(!v)close()}}><SheetContent aria-describedby={undefined} showCloseButton={false} className="w-[min(640px,90vw)] gap-0 sm:max-w-none" onCloseAutoFocus={e=>{e.preventDefault();trigger.current?.focus?.({preventScroll:true})}}><div className="drawerhead"><SheetTitle className="min-w-0 truncate font-normal text-fg3">{label}</SheetTitle><Button variant="ghost" size="icon" onClick={close} aria-label="Close panel"><X/></Button></div><div className="drawerbody">{children}</div></SheetContent></Sheet>}

const placeName={local:"Local",cloud:"Cloud"};
const methodName={app:"GitHub App",pat:"Personal access token",cli:"GitHub CLI"};
function makeIdentity(user, connected=true, cli=false) {
  const login=people[user].login;
  const method=connected?"app":null;
  return {
    accounts:connected?[{method,login}]:[],
    sharedLogin:connected?login:null,
    workspaceMethods:{local:cli?"cli":method,cloud:method},
    deviceLogin:login
  };
}
const initialIdentities=Object.fromEntries(["arun","maya"].map(user=>[user,makeIdentity(user)]));
function credentialFor(state,method,login=state.sharedLogin) {
  return state.accounts.find(account=>account.method===method&&account.login===login);
}
function identityView(state) {
  const effective=place=>{
    const method=state.workspaceMethods[place];
    if(place==="local"&&method==="cli")return {method,login:state.deviceLogin};
    return credentialFor(state,method);
  };
  const local=effective("local"),cloud=effective("cloud");
  return {...state,local:local?.method,localLogin:local?.login,cloud:cloud?.method,
    cloudLogin:cloud?.login,appLogin:cloud&&credentialFor(state,"app")?cloud.login:null};
}
function saveCredential(state,method,login){
  const exists=state.accounts.some(a=>a.method===method&&a.login===login);
  return exists?state:{...state,accounts:[...state.accounts,{method,login}]};
}
function IntegrationDirectory({methods,configure}){
  const {cloud}=React.useContext(Preview);
  const count=[methods.local,cloud&&methods.cloud].filter(Boolean).length;
  return <><div className="title"><h1>Integrations</h1><p>Connected accounts and workspaces</p></div>
    <div className="inventory provider-list"><ListRow className="provider-row" onClick={configure}>
      <span className="service-icon"><GitHubMark/></span><span className="grow"><strong>GitHub</strong><small>Repositories, pull requests, and your account</small></span>
      <Badge variant={count?"success":"neutral"}>{count===(cloud?2:1)?"Connected":count===1?"Partially connected":"Not connected"}</Badge><G n="chev"/>
    </ListRow></div></>;
}
function AccountChooser({user,onSelect,cancel,saved,onlyLogin}){
  const [expired,setExpired]=useState(false),[verifying,setVerifying]=useState("");
  useEffect(()=>{
    if(!verifying)return;
    const timer=setTimeout(()=>onSelect(verifying),450);
    return ()=>clearTimeout(timer);
  },[verifying]);
  if(verifying)return <div className="auth-wait" role="status"><RefreshCw size={20}/><h2>Connecting GitHub</h2><p>Verifying @{verifying}…</p></div>;
  if(expired)return <><h2>Authorization expired</h2><p className="info">{saved?"Your saved account is still connected.":"Choose an account again to finish linking GitHub."}</p><Button onClick={()=>setExpired(false)}>Try again</Button></>;
  return <><div className="auth-brand"><GitHubMark size={26}/><Link size={15}/><span className="brandmark" aria-hidden dangerouslySetInnerHTML={{__html:logo}}/></div>
    <h2>Authorize Zeros</h2><p className="info">Choose your GitHub account. This is a simulated GitHub authorization.</p>
    <div className="account-list">{(onlyLogin?[onlyLogin]:[people[user].login,user+"-withso"]).map((login,i)=><div className="account-summary" key={login}>
      <span className="avatar">{login.slice(0,2).toUpperCase()}</span><div className="grow"><strong>@{login}</strong><small>{i?"Work account":"Signed in to GitHub"}</small></div>
      <Button variant={i?"secondary":"primary"} aria-label={"Authorize @"+login} onClick={()=>setVerifying(login)}>{i?"Select":"Continue"}</Button>
    </div>)}</div><div className="actions"><Button variant="ghost" onClick={cancel}>Cancel</Button><Button variant="ghost" onClick={()=>setExpired(true)}>Preview timeout</Button></div></>;
}
function WorkspaceMethods({state,onChoose}) {
  const {cloud,signedOut}=React.useContext(Preview);
  return <section className="integration-section" aria-labelledby="workspace-identity">
    <h2 id="workspace-identity">Workspace identity</h2>
    <div className="identity-surface">
      {(cloud?["local","cloud"]:["local"]).map(place=>{
        const available=signedOut?["pat","cli"]:place==="local"?["app","pat","cli"]:["app","pat"];
        const chosen=state.workspaceMethods[place];
        const hint=state[place]?"@"+state[place+"Login"]:chosen&&state.sharedLogin?
          "Connect "+methodName[chosen]+" for @"+state.sharedLogin:"No account in use";
        return <div key={place} className="identity-line" data-place={place}>
          <span className="identity-icon">{place==="local"?<Laptop/>:<Cloud/>}</span>
          <div className="identity-copy"><strong>{place==="cloud"?"Cloud · Withso":"Local"}</strong><small>{hint}</small></div>
          <Select value={state[place]||""} onValueChange={value=>onChoose(place,value)}>
            <SelectTrigger id={"workspace-"+place} aria-label={placeName[place]+" method"}><SelectValue placeholder={chosen?"Set up method":"Choose method"}/></SelectTrigger>
            <SelectContent>
              {available.map(method=><SelectItem key={method} value={method}>{methodName[method]}</SelectItem>)}

            </SelectContent>
          </Select>
          {chosen&&<Button variant="ghost" size="icon" aria-label={"Disconnect "+placeName[place]} title={"Disconnect "+placeName[place]} onClick={()=>onChoose(place,"off")}><X/></Button>}
        </div>;
      })}
    </div>
  </section>;
}
function TokenForm({user,current,onSave}) {
  const {later}=React.useContext(Preview);
  const [draft,setDraft]=useState(""),[result,setResult]=useState(null);
  const mismatch=result?.login&&current&&current!==result.login;
  function verify(event){
    event.preventDefault();
    const samples=new Map([["demo-personal",people[user].login],["demo-work",user+"-withso"]]);
    const login=samples.get(draft.trim());
    setDraft("");setResult(login?{login}:{error:true});
  }
  return <form className="token-form" onSubmit={verify}>
    <label htmlFor="token-draft">Personal access token</label>
    <Input type="password" id="token-draft" autoComplete="off" value={draft} onChange={e=>{setDraft(e.target.value);setResult(null)}} placeholder="Paste a sample token"/>
    <p>Offline samples: <code>demo-personal</code> or <code>demo-work</code>.</p>
    <Button size="compact" type="submit" disabled={!draft.trim()}>Verify token</Button>
    {result&&<div role="status" className="token-result">{result.error?"Verification failed. Paste one of the sample tokens and try again.":<>
      <strong>GitHub reports @{result.login}</strong><p>{mismatch?(later?"This token belongs to a different account. Saving it keeps your current identity selected.":"This token belongs to a different GitHub account. Use a token for @"+current+"."):"Verified in this simulation."}</p>
      {(!mismatch||later)&&<Button type="button" size="compact" onClick={()=>onSave("pat",result.login)}>{mismatch?"Add as another account":"Use verified token"}</Button>}
    </>}</div>}
  </form>;
}
function CredentialEditor({user,editor,state,onSave,onCancel}) {
  const {signedOut}=React.useContext(Preview);
  const [method,setMethod]=useState(editor.method);
  const choices=signedOut?[["pat",methodName.pat],["cli",methodName.cli]]:[["app",methodName.app],["pat",methodName.pat]];
  const add=editor.kind==="add",first=editor.kind==="first";
  const title=first?"Connect GitHub":add?"Add a GitHub account":"Connect "+methodName[method];
  return <div className="credential-editor" role="region" aria-label={title}>
    <div className="editor-heading"><h3>{title}</h3><Button variant="ghost" size="icon" aria-label="Cancel setup" onClick={onCancel}><X/></Button></div>
    {(add||first)&&<Seg label="Sign-in method" value={method} set={setMethod} items={choices}/>}
    {method==="pat"?<TokenForm user={user} current={state.sharedLogin} onSave={onSave}/>:
     method==="cli"?<Button onClick={()=>onSave("cli",state.deviceLogin)}>Use GitHub CLI on this Mac</Button>:
     <AccountChooser user={user} saved={!!state.sharedLogin} onlyLogin={add?(state.sharedLogin===people[user].login?user+"-withso":people[user].login):state.sharedLogin} cancel={onCancel} onSelect={id=>onSave("app",id)}/>}
  </div>;
}
function PersonalGitHub({user,methods,change,connections,installs,needsLink}) {
  const {later,cloud,signedOut,variant}=React.useContext(Preview);
  const [editor,setEditor]=useState(null),[remove,setRemove]=useState(null),[target,setTarget]=useState(null),[message,setMessage]=useState("");
  const login=methods.sharedLogin,logins=[...new Set(methods.accounts.map(a=>a.login))];
  const places=cloud?["local","cloud"]:["local"];
  function reset(){setEditor(null);setRemove(null);setTarget(null);setMessage("")}
  function begin(method,kind,place){reset();setEditor({method,kind,place})}
  function choose(place,method){
    if(method!=="off"&&method!=="cli"&&!credentialFor(methods,method)){begin(method,"setup",place);return}
    reset();change(s=>({...s,workspaceMethods:{...s.workspaceMethods,[place]:method==="off"?null:method}}));
  }
  function save(method,id){
    change(s=>{
      if(method==="cli")return {...s,workspaceMethods:{...s.workspaceMethods,local:"cli"}};
      if(!later&&s.sharedLogin&&id!==s.sharedLogin)return s;
      const next=saveCredential(s,method,id),workspaceMethods={...s.workspaceMethods};
      if(!s.sharedLogin||s.sharedLogin===id){
        if(editor.place)workspaceMethods[editor.place]=method;
        else if(!s.accounts.length)for(const place of places)workspaceMethods[place]??=method;
      }
      return {...next,sharedLogin:s.sharedLogin||id,workspaceMethods};
    });reset();setMessage("@"+id+" connected with "+methodName[method]+".");
  }
  function disconnect(method){
    change(s=>{
      const accounts=s.accounts.filter(a=>a.method!==method||a.login!==login);
      return {...s,accounts,sharedLogin:accounts.some(a=>a.login===login)?login:null};
    });reset();
  }
  const next=target?identityView({...methods,sharedLogin:target}):null;
  const relink=next&&cloud?connections.filter(c=>installs[c.owner]&&needsLink(c,next)):[];
  const first=!login&&!logins.length&&!methods.local;
  const form=editor&&<CredentialEditor key={[user,editor.kind,editor.method,editor.place].join("-")} user={user} editor={editor} state={methods} onSave={save} onCancel={reset}/>;
  const accountControl=later&&logins.length?<Select value={login||""} onValueChange={value=>{
    if(value==="add"){begin(signedOut?"pat":"app","add");return}reset();setTarget(value);
  }}><SelectTrigger aria-label="Shared account" title="GitHub account"><SelectValue placeholder="Choose account"/></SelectTrigger><SelectContent>
    {logins.map(id=><SelectItem key={id} value={id}>@{id}</SelectItem>)}
    {logins.length<2&&<SelectItem value="add">Add account…</SelectItem>}</SelectContent></Select>:
    login?null:<Button size="compact" onClick={()=>begin(signedOut?"pat":"app","first")}>Connect GitHub</Button>;
  return <div className="github-overview identity-page"><header className="integration-title"><h1><GitHubMark size={24}/>GitHub</h1><p>{signedOut?"Local GitHub sign-in while signed out of Zeros.":variant==="personal"?"Your GitHub identity on this Mac.":"Choose the account and method for GitHub actions."}</p></header>
    {first?<section className="integration-section">{form||<div className="identity-line"><Button variant="primary" onClick={()=>begin(signedOut?"pat":"app","first")}><GitHubMark size={16}/>Connect GitHub</Button></div>}</section>:<>
    <WorkspaceMethods state={methods} onChoose={choose}/>
    {cloud&&methods.paused&&<p className="notice">Your running cloud workspaces are paused after the account switch.</p>}
    <section className="integration-section"><div className="section-line"><h2>Authentication methods</h2>{accountControl}</div>
    {(editor?.kind==="add"||editor?.kind==="first")&&form}
    {target&&<section className="credential-editor" aria-label="Account switch impact"><h3>Switch to @{target}?</h3>
      {places.map(place=><p key={place}><strong>{placeName[place]}</strong> · {next[place]?"Uses "+methodName[next[place]]+" as @"+next[place+"Login"]:methods[place]?"Loses its "+methodName[methods[place]]+" sign-in":"No sign-in"}</p>)}
      {cloud&&<><p>Need Link: {relink.length?relink.map(c=>"@"+c.owner).join(", "):"None"}.</p><p>Your running Withso cloud workspaces pause on confirmation.</p></>}
      <div className="inline-actions"><Button onClick={reset}>Cancel</Button><Button variant="primary" onClick={()=>{change(s=>({...s,sharedLogin:target,paused:cloud||s.paused}));reset();setMessage("Switched to @"+target+".")}}>Confirm switch</Button></div></section>}
    <div className="identity-surface">
    {(signedOut?["pat"]:["app","pat"]).map(method=>{
      const configured=credentialFor(methods,method);
      return <React.Fragment key={method}><div className="identity-line"><span className="identity-icon">{method==="app"?<GitHubMark size={18}/>:<KeyRound/>}</span>
        <div className="identity-copy"><strong>{methodName[method]}</strong><small>{configured?"Connected as @"+login:"Not connected"}</small></div>
        {configured?<DropdownMenu modal={false}><DropdownMenuTrigger asChild><Button variant="ghost" size="icon" aria-label={methodName[method]+" options"}><Ellipsis/></Button></DropdownMenuTrigger><DropdownMenuContent align="end">
          {method==="pat"&&<DropdownMenuItem onSelect={()=>begin("pat","setup")}>Replace token…</DropdownMenuItem>}
          <DropdownMenuItem variant="destructive" onSelect={()=>{reset();setRemove(method)}}>Disconnect method…</DropdownMenuItem></DropdownMenuContent></DropdownMenu>:
          <Button size="compact" aria-label={"Connect "+methodName[method]} onClick={()=>begin(method,"setup")}>Connect</Button>}
      </div>{editor?.kind==="setup"&&editor.method===method&&form}
      {remove===method&&<div className="credential-editor"><p>Disconnect {methodName[method]} for @{login}?</p><Button onClick={reset}>Cancel</Button> <Button onClick={()=>disconnect(method)}>Disconnect method</Button></div>}</React.Fragment>})}</div>
      <div className="identity-device identity-line"><span className="identity-icon"><Terminal/></span><div className="identity-copy"><strong>GitHub CLI</strong><small>@{methods.deviceLogin} on this Mac</small></div><span className="device-label">Local only</span></div>
    </section></>}<p className="identity-feedback" role="status">{message}</p></div>;
}

const seedInstalls={
  Withso:Object.keys(seedConnections[0].repos),
  iamarunrk:Object.keys(seedConnections[1].repos),
  Northstar:["Northstar/dashboard"]
};
function authorizedFor(login,owner){
  if(!login)return false;
  if(login.endsWith("-withso"))return owner==="Withso";
  if(organizationInstallations.has(owner))return ["iamarunrk","maya-dev"].includes(login);
  return login===owner||catalog[owner]?.some(repo=>repo[login==="iamarunrk"?2:3]);
}
function canInstall(login,owner){
  return login===owner||(login==="iamarunrk"&&["Withso","Studio-Labs","Northstar","arun-labs"].includes(owner));
}
function LinkInstallation({connection,user,methods,authorize,done,close}){
  const [error,setError]=useState(false);
  return <Drawer label={"Connections / @"+connection.owner} close={close}>
    {error?<><h2>Account can’t link this installation</h2><p className="info">Use a GitHub identity with access to @{connection.owner}. Choose an authorized identity on the GitHub identity page, then try again.</p><Button onClick={close}>Done</Button></>:
    <><div className="link-info"><G n="link"/><span>Zeros is already installed on @{connection.owner}. Link your account to continue. Authorize your GitHub account to reuse this installation.</span></div>
    {methods.cloud==="pat"&&<p className="info">Finding installations needs GitHub App sign-in. Continuing selects GitHub App for Cloud · Withso. Local keeps its method.</p>}
    <AccountChooser user={user} onlyLogin={methods.sharedLogin} saved={Boolean(methods.cloud)} cancel={close} onSelect={id=>{
      if(!authorizedFor(id,connection.owner)){setError(true);return}
      authorize(id);done(id);
    }}/></>}
  </Drawer>;
}
function ConnectionDetail({c,user,close,update,cs,projects,remove,initialTab="general",installedRepos,installed,linked,recordInstall}){
 const [tab,setTab]=useState(initialTab),[q,setQ]=useState(""),[edit,setEdit]=useState(false),[selected,setSelected]=useState([]),[deleting,setDeleting]=useState(false),[sync,setSync]=useState(false);
 const [expanded,setExpanded]=useState(""),[handoff,setHandoff]=useState(false),[returned,setReturned]=useState(false);
 const {later}=React.useContext(Preview);
 const {eligible,access,canSeeProject}=React.useContext(AccessModel);
 const org=c.scope==="org",manager=owns(c,user),canConfigure=manager||(later&&org&&c.grants?.[user]?.includes("configure"));
 const canShare=manager||(later&&org&&c.grants?.[user]?.includes("share"));
 const granted=linked?installedRepos.filter(r=>access(r,user)):[];
 const visible=(later?Object.keys(c.repos):installedRepos).filter(r=>granted.includes(r)&&(manager||eligible(c,r,user)));
 const changeRepo=(r,a)=>update({...c,repos:{...c.repos,[r]:a}});
 const allowedProjects=projects.filter(p=>canSeeProject(p,user,cs));
 const {solo}=React.useContext(Preview);
 const audienceOptions=(solo?["arun","all"]:["arun","maya","all"]).map(v=>[v,audienceName(v)]);
 if(handoff)return <GithubHandoff owner={c.owner} previous={installedRepos} onCancel={()=>setHandoff(false)} onReturn={repos=>{recordInstall(c.owner,repos);setHandoff(false);setReturned(true);setSync(true)}}/>;
 return <Drawer label={"Connections / @"+c.owner} close={close}><div className="drawer-title"><h2 className="pair"><GitHubMark size={22}/>@{c.owner}</h2><small>GitHub</small></div><Seg label="Connection details" value={tab} set={v=>{setTab(v);setEdit(false);setDeleting(false)}} items={[["general","General"],["access","Manage access"],["repos","Repositories"]]}/>
 {tab==="general"&&<><section className="block"><Heading title="Connection settings"/><div className="setting-surface detail-group">
 <Row title="Account" hint={org?"Shared in Withso":"Private to "+people[user].name}>{installed&&linked?<span className="status"><span className="dot"/>Connected</span>:<small>{installed?"Account link required":"Installation removed"}</small>}</Row>
 <Row title="Repository selection" hint={visible.length+" repositories available to you"}><Button onClick={()=>setTab("repos")}>View repositories</Button></Row>
 {later&&canConfigure&&<Row title="Connection label"><Input aria-label="Connection label" type="text" maxLength={34} value={c.label||""} placeholder="GitHub App" style={{maxWidth:145}} onChange={e=>update({...c,label:e.target.value})}/></Row>}
 </div></section>
 {manager&&<section className="block"><Heading title="Danger zone"/><div className="setting-surface detail-group"><Row title="Disconnect connection" hint={deleting?"Projects using this connection will lose this source.":"Remove this connection from "+(org?"Withso.":"your personal settings.")}>{deleting?<><Button variant="ghost" onClick={()=>setDeleting(false)}>Cancel</Button><Button variant="destructive" onClick={()=>remove(c.id)}>Disconnect</Button></>:<Button variant="destructive-secondary" onClick={()=>setDeleting(true)}>Disconnect connection</Button>}</Row></div></section>}</>}
 {tab==="access"&&<section className="block">
 {org?(later?<ConnectionMembers connection={c} manage={manager} update={update}/>:null):<><Heading title="Manage access" desc="Only you can see and use this personal connection."/><div className="inventory minisection"><div className="grantrow"><span className="avatar">{people[user].initials}</span><span className="grow">{people[user].name}<small>Personal owner</small></span><Scope scope={user}/></div></div></>}
 <EffectiveRepositories connection={c} visible={visible} user={user} canLimit={canShare} changeLimit={changeRepo} options={audienceOptions}/></section>}
 {tab==="repos"&&<section className="block"><Heading title="Repositories" desc={edit?"Select repositories to make available through this connection.":"Repositories available through this connection."}/>
 {edit?<div className="minisection"><CheckList items={granted} chosen={selected} set={setSelected}/><div className="actions"><Button variant="ghost" onClick={()=>setEdit(false)}>Cancel</Button><Button variant="primary" disabled={!selected.length} onClick={()=>{update({...c,repos:Object.fromEntries(selected.map(r=>[r,c.repos[r]||user]))});setEdit(false)}}>Save selection</Button></div></div>:<>
 <div className="inventory minisection"><div className="searchbar"><G n="search"/><Input appearance="inline" type="search" aria-label="Search repositories" placeholder="Search repositories…" value={q} onChange={e=>setQ(e.target.value)}/>{canConfigure&&<Button variant="ghost" size="compact" onClick={()=>setSync(true)}><RefreshCw/>Refetch repo list</Button>}</div>
 {visible.filter(r=>r.toLowerCase().includes(q.trim().toLowerCase())).map(r=>{const used=allowedProjects.filter(p=>p.repos.includes(r)&&(org?p.scope==="org":p.scope===user));return <React.Fragment key={r}><ListRow className="repotoggle" aria-expanded={expanded===r} onClick={()=>setExpanded(expanded===r?"":r)}><span className="grow">{r}</span><Badge>{isPublic(r)?"Public":"Private"}</Badge></ListRow>{expanded===r&&<div className="repodetail">{org?(later?audienceName(c.repos[r]):"Withso"):"Only you"} · {used.length?"Used by "+used.map(p=>p.name).join(", "):"No visible projects using this source"}</div>}</React.Fragment>})}{!visible.some(r=>r.toLowerCase().includes(q.trim().toLowerCase()))&&<p className="empty">{visible.length?"No matching repositories.":"You can view this connection. No repositories are available to you."}</p>}</div>
 <div className="listfoot"><span role="status">{sync?"Last fetched just now":"Last fetched 16 hours ago"}</span>{manager&&installed&&linked&&<Button variant="ghost" size="compact" onClick={()=>setHandoff(true)}>Manage on GitHub <ArrowUpRight/></Button>}</div>
 {returned&&<p className="notice" role="status">GitHub now grants {granted.length} {granted.length===1?"repository":"repositories"} to your account. {granted.join(", ")||"No repositories available."}</p>}
 {later&&manager&&installed&&linked&&<Button onClick={()=>{setSelected(visible);setEdit(true)}}>Edit Zeros subset</Button>}</>}</section>}</Drawer>

}
function EffectiveRepositories({connection,visible,user,canLimit,changeLimit,options}){
 const {eligible,access,linkedMembers}=React.useContext(AccessModel);
 const {later}=React.useContext(Preview);
 const [expanded,setExpanded]=useState(visible[0]||null);
 const org=connection.scope==="org";
 const reviewers=org&&(canLimit||owns(connection,user))?linkedMembers:[user];
 return <section className="block">
   <Heading title="Repository access" desc="Compare GitHub permissions with effective access in Zeros."/>
   <div className="inventory minisection">
     {visible.map(repo=>{
       const open=expanded===repo;
       const count=reviewers.filter(member=>eligible(connection,repo,member)).length;
       return <React.Fragment key={repo}>
         <ListRow className="mirror-repo" aria-expanded={open} onClick={()=>setExpanded(open?null:repo)}>
           <G n={open?"down":"chev"}/><span className="grow">{repo}</span>
           <small>{reviewers.length===1?"Your access":count+" "+(count===1?"member":"members")}</small>
         </ListRow>
         {open&&<div className="mirror-details">
           <table aria-label={"Effective access for "+repo}><thead><tr><th>Member</th><th>GitHub</th><th>In Zeros</th></tr></thead>
             <tbody>{reviewers.map(member=>{
               const permission=access(repo,member);
               const level=permission==="write"?"Write":permission==="read"?"Read":"No access";
               return <tr key={member}><th scope="row">{people[member].name}</th><td>{level}</td><td>{eligible(connection,repo,member)?level:"No access"}</td></tr>;
             })}</tbody>
           </table>
           {org&&later&&<div className="limit-row"><span>Zeros audience limit</span>{canLimit?<Picker quiet label={"Zeros limit for "+repo} value={connection.repos[repo]} items={options} set={v=>changeLimit(repo,v)}/>:<small>{audienceName(connection.repos[repo])}</small>}</div>}
           <a className="mirror-link" href={"https://github.com/"+repo} target="_blank" rel="noreferrer">View repository on GitHub <ArrowUpRight size={12}/></a>
         </div>}
       </React.Fragment>;
     })}
     {!visible.length&&<p className="empty">No eligible repositories.</p>}
   </div>
 </section>;
}

const permissionOptions = [
  ["view","Can view","See the connection and repositories available to you."],
  ["configure","Can configure","Edit the connection label and refresh its repository list."],
  ["share","Can share","Change who in Zeros can use eligible repositories."]
];

function memberAccessLabel(grants){
  if(grants.length===2)return "Configure & share";
  return permissionOptions.find(([key])=>grants.includes(key))?.[1]||"Can view";
}

function MemberPermissionMenu({member,grants,change}){
  return <DropdownMenu modal={false}>
    <DropdownMenuTrigger asChild>
      <Button variant="ghost" size="compact" aria-label={people[member].name+" permissions: "+memberAccessLabel(grants)}>
        {memberAccessLabel(grants)}<ChevronDown size={13}/>
      </Button>
    </DropdownMenuTrigger>
    <DropdownMenuContent align="end" className="permission-menu" aria-label={"Permissions for "+people[member].name}>
      {permissionOptions.map(([key,title,hint])=><DropdownMenuCheckboxItem
        key={key} aria-label={title} className="permission-option" checked={key==="view"||grants.includes(key)} disabled={key==="view"}
        onSelect={event=>event.preventDefault()} onCheckedChange={checked=>{
          if(key!=="view")change(checked?[...grants,key]:grants.filter(value=>value!==key));
        }}>
        <span><span>{title}</span><small>{hint}</small></span>
      </DropdownMenuCheckboxItem>)}
      {grants.length>0&&<><DropdownMenuSeparator/><DropdownMenuItem variant="destructive" onSelect={()=>change([])}>
        <Trash2/>Remove direct access
      </DropdownMenuItem></>}
    </DropdownMenuContent>
  </DropdownMenu>;
}

function ConnectionMembers({connection,manage,update}){
  const [expanded,setExpanded]=useState("");
  const [query,setQuery]=useState("");
  const needle=query.trim().toLowerCase();
  const {solo}=React.useContext(Preview);
  const roster=Object.entries(people).filter(([id])=>!solo||id==="arun");
  const roles=[
    {name:"Owners and admins",permission:"Full access",members:roster.filter(([id])=>admin(id))},
    {name:"Members",permission:"Can view",members:roster.filter(([id])=>!admin(id))}
  ];
  const change=(member,grants)=>{
    const next={...connection.grants};
    if(grants.length)next[member]=grants;
    else delete next[member];
    update({...connection,grants:next});
  };
  return <>
    <Heading title="Connection permissions" desc="Members inherit view access. Owners and admins can change permissions on each member’s row."/>
    <div className="inventory minisection" aria-label="Withso connection permissions">
      <label className="member-search"><Search size={14}/><Input type="search" appearance="inline" aria-label="Search Withso members in Zeros" placeholder="Search members…" value={query} onChange={event=>setQuery(event.target.value)}/></label>
      {roles.map(role=>{
        const matches=role.members.filter(([,person])=>person.name.toLowerCase().includes(needle));
        if(!matches.length)return null;
        const open=Boolean(needle)||expanded===role.name;
        return <React.Fragment key={role.name}>
          <ListRow className="role-disclosure" aria-expanded={open} onClick={()=>{setQuery("");setExpanded(open?"":role.name)}}>
            <G n={open?"down":"chev"}/><span className="grow">{role.name}<small>Zeros role · {role.members.length} {role.members.length===1?"person":"people"}</small></span><small>{role.permission}</small>
          </ListRow>
          {open&&matches.map(([id,person])=>{
            const direct=connection.grants?.[id]||[];
            return <div key={id} className="inherited-member with-permission"><span className="avatar" aria-hidden="true">{person.initials}</span>
              <span className="grow">{person.name}{direct.length>0&&<small>Direct grant</small>}</span>
              {manage&&!admin(id)?<MemberPermissionMenu member={id} grants={direct} change={values=>change(id,values)}/>:<small>{admin(id)?"Full access":memberAccessLabel(direct)}</small>}
            </div>;
          })}
        </React.Fragment>;
      })}
      {!roster.some(([,person])=>person.name.toLowerCase().includes(needle))&&<p className="empty">No matching Zeros member in Withso.</p>}
    </div>
  </>;
}

function GithubHandoff({owner,previous,onCancel,onReturn}){
 const all=catalog[owner].map(r=>owner+"/"+r[0]);
 const [selected,setSelected]=useState(previous||[all[0]]);
 const heading=useRef(null);
 useEffect(()=>{heading.current?.focus()},[]);
 return <main className="github-host"><div className="github-host-inner">
   <div className="auth-brand"><GitHubMark size={23}/><span>GitHub · Offline simulation</span></div>
   <h1 tabIndex={-1} ref={heading}>{previous?"Configure Zeros":"Install Zeros"} on @{owner}</h1>
   <p className="info">On GitHub, the installation owner chooses the repositories the Zeros App can access. <a href={organizationInstallations.has(owner)?"https://github.com/organizations/"+owner+"/settings/installations":"https://github.com/settings/installations"} target="_blank" rel="noreferrer">Open GitHub settings <ArrowUpRight size={12}/></a></p>
   <Heading title="Repository access"/><CheckList items={all} chosen={selected} set={setSelected}/>
   <div className="actions"><Button onClick={onCancel}>Cancel</Button><Button variant="primary" disabled={!selected.length} onClick={()=>onReturn(selected)}>Save on GitHub and return</Button></div>
 </div></main>;
}
function AddConnection({user,scope,connections,installs,recordInstall,methods,authorize,save,close,initialOwner="",restore=false}){
 const {later,solo}=React.useContext(Preview);
 const {access}=React.useContext(AccessModel);
 const [dest,setDest]=useState(scope),[owner,setOwner]=useState(initialOwner),[step,setStep]=useState("destination"),[chosen,setChosen]=useState([]),[aud,setAud]=useState(user);
 const personalOwners=admin(user)?[people[user].login,"arun-labs"]:[people[user].login];
 const orgOwners=["Withso","Studio-Labs","Northstar",...(later?[people[user].login]:[])];
 const options=restore?[initialOwner]:(dest==="org"?orgOwners:personalOwners).filter(o=>!connections.some(c=>c.scope===dest&&c.owner===o));
 const account=options.includes(owner)?owner:options[0];
 const installed=installs[account];
 const granted=(installed||[]).filter(repo=>access(repo,user));
 function resume(login){
   if(!authorizedFor(login,account)||(!installed&&!canInstall(login,account))){setStep("denied");return}
   setChosen(installed||[]);setStep(installed?"granted":"install");
 }
 function finish(){
   const selected=later?granted.filter(r=>chosen.includes(r)):granted;
   save({id:mkId(),owner:account,scope:dest,repos:Object.fromEntries(selected.map(r=>[r,dest==="org"?(later?aud:"all"):user]))});
 }
 if(step==="github")return <GithubHandoff owner={account} previous={installed} onCancel={()=>setStep(installed?"granted":"install")} onReturn={repos=>{recordInstall(account,repos);setChosen(repos);setStep("granted")}}/>;
 return <Drawer label="Add GitHub connection" close={close}>
 {step==="destination"?<><h2>{restore?"Restore GitHub installation":"Add GitHub connection"}</h2>
 <label className="formlabel">Who is this for?</label><Seg value={dest} items={restore?[[dest,dest==="org"?"Withso":"Only you"]]:[[user,"Only you"],...(admin(user)?[["org","Withso"]]:[])]} set={v=>{setDest(v);setOwner("")}}/>
 <label className="formlabel">GitHub account or organization</label>{account?<Picker label="GitHub account" value={account} items={options.map(id=>[id,"@"+id])} set={setOwner}/>:<p>No more installations to connect here.</p>}
 <div className="actions"><Button variant="primary" disabled={!account} onClick={()=>methods.cloud==="app"?resume(methods.cloudLogin):setStep("authorize")}>Continue</Button></div></>:
 step==="authorize"?<>{methods.cloud==="pat"&&<p className="link-info">Finding installations needs GitHub App sign-in. Continuing selects GitHub App for Cloud · Withso. Local keeps its method.</p>}<AccountChooser user={user} onlyLogin={methods.sharedLogin} saved={!!methods.cloud} cancel={()=>setStep("destination")} onSelect={id=>{authorize(id);resume(id)}}/></>:
 step==="denied"?<><h2>GitHub owner approval required</h2><p className="info">The selected identity cannot manage @{account}. Ask its GitHub owner to install Zeros, then return to link it.</p><Button onClick={()=>setStep("destination")}>Back</Button></>:
 step==="install"?<><h2>{restore?"Reinstall":"Install"} Zeros on GitHub</h2><p className="info">Choose the repository grant on GitHub, then return to Zeros.</p><Button variant="primary" onClick={()=>setStep("github")}>Manage on GitHub <ArrowUpRight/></Button></>:
 <><h2>{restore?"Restore connection":"Link existing installation"}</h2><p className="info">GitHub now grants {granted.length} {granted.length===1?"repository":"repositories"} to your account on @{account}.</p>
 {later?<><Heading title="Zeros repository subset" desc="Choose from GitHub’s grant for this connection."/><CheckList items={granted} chosen={chosen} set={setChosen}/>{dest==="org"&&<Row title="Repository audience"><Picker label="Repository audience" items={(solo?["arun","all"]:["arun","maya","all"]).map(a=>[a,audienceName(a)])} value={aud} set={setAud}/></Row>}</>:<div className="inventory">{granted.map(repo=><div className="access-row" key={repo}><G n="repo"/>{repo}</div>)}</div>}
 <div className="actions">{canInstall(methods.cloudLogin,account)&&<Button onClick={()=>setStep("github")}>Manage on GitHub <ArrowUpRight/></Button>}<Button variant="primary" disabled={later&&!granted.some(r=>chosen.includes(r))} onClick={finish}>{restore?"Restore connection":"Link"}</Button></div></>}
 </Drawer>;
}

function ProjectForm({user,cs,projects,project,close,save,promote,allowed}){
 const {later,solo}=React.useContext(Preview);
 const {permitted,access}=React.useContext(AccessModel);
 const existing=!!project,[scope,setScope]=useState(project?.scope||(allowed?user:"org")),[name,setName]=useState(project?.name||""),[chosen,setChosen]=useState(project?.repos||[]),[confirm,setConfirm]=useState(false);
 const org=scope==="org",repositories=permitted(cs,user,org),shared=permitted(cs,user,true);
 const missing=chosen.filter(r=>!shared.includes(r)),members=Object.keys(people).filter(id=>(!solo||id==="arun")&&chosen.length&&chosen.every(r=>permitted(cs,id,true).includes(r)));
 const duplicated=(dest)=>projects.some(p=>p.scope===dest&&p.id!==project?.id&&p.name.toLowerCase()===name.trim().toLowerCase());
 const shareOK=existing&&!org&&admin(user)&&!missing.length&&!duplicated("org");
 const readers=members.map(id=>people[id].name).join(", ")||"Nobody yet";
 return <Drawer label={existing?"Project details":"Create project"} close={close}><h2>{existing?name:"New project"}</h2>{existing?<p className="minisection"><Scope scope={scope}/></p>:<><label className="formlabel" htmlFor="pname">Project name</label><input id="pname" type="text" maxLength={64} placeholder="e.g. Design system" value={name} onChange={e=>setName(e.target.value)}/><label className="formlabel">Who can see this project?</label><Seg value={scope} items={[...(allowed?[[user,"Only you"]]:[]),...(admin(user)?[["org","Withso"]]:[])]} set={v=>{setScope(v);setChosen(chosen.filter(r=>permitted(cs,user,v==="org").includes(r)))}}/></>}
 <p className="info">{org?(later?"Withso members can discover and open this project when they can use every repository in it.":"Withso members can see this project. Creating a workspace checks the creator’s GitHub access to each repository."):"Only "+people[user].name+" can see this project, its repository list and its workspaces."}</p><section className="block"><Heading title={existing?"Project repositories":"Choose repositories"} desc={existing?null:org?"From organization connections you can use.":"From your own connections and organization repositories you can use."}/>{existing?<div className="box">{chosen.map(r=><Row key={r} title={r} hint={permitted(cs,user,org).includes(r)?(access(r,user)==="write"?"Read and write":"Read only"):"Access unavailable"}/>)}</div>:<CheckList items={repositories} chosen={chosen} set={setChosen}/>}</section>
 {org&&chosen.length>0&&<p className="hint">Eligible in this example · {readers}</p>}
 {!existing?<>{duplicated(scope)&&<p className="info">A project in this audience already uses that name.</p>}<div className="actions"><Button onClick={close}>Cancel</Button><Button variant="primary" disabled={!name.trim()||!chosen.length||duplicated(scope)||(!allowed&&!org)} onClick={()=>save({id:mkId(),name:name.trim(),scope,repos:chosen})}>Create project</Button></div></>:!org&&admin(user)?<section className="block"><Heading title="Share with Withso"/>{missing.length?<><p className="muted compact">An organization connection must cover every repository. Give Withso access to the selected repositories, then return here to review the audience.</p><div className="box minisection">{missing.map(r=><Row key={r} title={r} hint="Organization access required"/>)}</div><p className="hint">{later?"In Connections, choose the Zeros subset and audience for an organization connection.":"An admin can link a GitHub organization installation under Connections. Personal connections stay owner-only."}</p></>:duplicated("org")?<p className="info">Withso already has a project with this name. Resolve the name conflict before sharing.</p>:<p className="info">Eligible members · {readers}. The project will use Withso’s repository connections. Existing workspaces stay private to you.</p>}<div className="actions">{confirm&&<Button onClick={()=>setConfirm(false)}>Cancel</Button>}<Button variant="primary" disabled={!shareOK} onClick={()=>confirm?promote():setConfirm(true)}>{confirm?"Confirm share with Withso":"Review sharing"}</Button></div></section>:!org?<p className="info">You own this personal project. Organization projects are published by owners and admins. You can give an admin the names of repositories you choose to propose for a separate shared project.</p>:null}</Drawer>
}

const tree="https://github.com/Withso/zeros/blob/0594ece4108495c346694f90e86e782b24263203/";
const settingsPath="apps/desktop/src/renderer/features/settings/",cloudPath="apps/control-plane/src/cloud/";
const examples=[
 ["disconnected","Connect your first account"],["methods","Switch between saved GitHub accounts"],
 ["new-install","Sign in, then install for an organization"],["link","Link your account to an installed organization"],
 ["existing","Link an existing installation to Zeros"],["reinstall","Restore a removed installation"],
 ["unavailable","Cloud projects unavailable"],["signed-out","Signed-out Local"],
 ["solo","One-person organization"],["pat-link","Link an organization while Cloud uses a token"],
 ["personal","Personal without an organization"]
];
function Cite({path,line,end}) {
 const label=path.split("/").pop()+":"+line+(end?"–"+end:"");
 return <a href={tree+path+"#L"+line+(end?"-L"+end:"")} target="_blank" rel="noreferrer">{label}</a>;
}
function Entry({title,children}){return <div className="finding"><h3>{title}</h3><div>{children}</div></div>}
function Notes({launch}) {
 const [tab,setTab]=useState("current");
 return <div className="notes"><div className="title"><h1>GitHub access in Zeros</h1><p>Implementation review at 0594ece · Offline product study</p></div>
 <Seg value={tab} set={setTab} items={[["current","How it works today"],["proposed","Proposed rules"],["walk","Try the prototype"]]}/>
 {tab==="current"?<article><h2>What already exists</h2>
 <Entry title="PR #1313 merged">On 26 November 2026, main received the unified GitHub App and PAT changes in commit 213adf22. GitHub CLI remains device-local. <a href="https://github.com/Withso/zeros/pull/1313" target="_blank" rel="noreferrer">PR #1313</a></Entry>
 <Entry title="Settings and ownership">Personal → Integrations and Organization → GitHub already ship. A cloud credential belongs to a person in a cloud owner. The UI also handles Personal without cloud and a one-person cloud owner. <Cite path={settingsPath+"settings-page.tsx"} line={321} end={336}/> · <Cite path={settingsPath+"settings-page.tsx"} line={1416} end={1455}/> · <Cite path={cloudPath+"github-connection-routes.ts"} line={50} end={59}/></Entry>
 <Entry title="Connections and projects">The two levels, installed-account linking, repositories sheet and personal-projects switch already exist when cloud projects are available. Personal inventory is owner-only. Organization projects are listed to members. The ready-copy create path checks each repository as the creator before proceeding. <Cite path={settingsPath+"cloud-github-levels.tsx"} line={59} end={114}/> · <Cite path={settingsPath+"cloud-github-levels.tsx"} line={119} end={172}/> · <Cite path={cloudPath+"projects.ts"} line={131} end={143}/> · <Cite path={cloudPath+"workspace-create.ts"} line={161} end={165}/></Entry>
 <Entry title="Repository access and authorship">Installation discovery and repository enumeration use the caller’s GitHub credential. VM Git and gh operations keep the selected person’s scope. Write requests check push access. Computer builds and Mac sync have a separate repository-scoped installation-token path. Commit authorship uses Git metadata. PR and comment authorship follows the authenticated API identity. <Cite path={cloudPath+"composition.ts"} line={220} end={243}/> · <Cite path={cloudPath+"github-selected-tokens.ts"} line={32} end={73}/></Entry>
 <h2>Why the #1313 sign-in timed out</h2>
 <Entry title="Identify the adapter first">The exact ten-minute message is emitted by the separate Cloud adapter. Settings chooses it when the server reports a connection without sharedDesktopApp support. Unified desktop sign-in and the separate Cloud flow have different completion paths. Arun’s screenshot shows separate “This Mac” and “Cloud” sections, which establishes that the unified #1313 flow was inactive in this attempt. A control plane older than #1313 can omit sharedDesktopApp. A Dev deployment with dev connections enabled returns false. The deployed build and capability response would distinguish the two. The reason for the timer expiry remains unverified. <Cite path={cloudPath+"github-connections.ts"} line={421} end={425}/> · <Cite path="apps/control-plane/src/dev-connections/config.ts" line={18} end={23}/> <Cite path={settingsPath+"settings-page.tsx"} line={1427} end={1443}/> · <Cite path={settingsPath+"cloud-github-section.tsx"} line={94} end={118}/></Entry>
 <Entry title="Unified desktop hand-off">GitHubSection calls ghAppConnect with the shared owner and expected generation when applicable. Electron posts to OAuth start. The control plane records state, chooses install or authorize, then exchanges the callback code on the server, persists the handoff and redirects to the completion page. Electron exchanges the single-use handoff. For a shared target the server saves the credential under that user and organization. <Cite path={settingsPath+"github-section.tsx"} line={405} end={434}/> · <Cite path="apps/desktop/electron/github-app-client.ts" line={368}/> · <Cite path="apps/control-plane/src/github.ts" line={1291} end={1360}/> · <Cite path="apps/control-plane/src/github.ts" line={1117} end={1133}/> · <Cite path="apps/desktop/electron/github-app-client.ts" line={432}/> · <Cite path="apps/control-plane/src/github.ts" line={1398} end={1443}/> · <Cite path="apps/control-plane/src/github.ts" line={1482} end={1498}/></Entry>
 <Entry title="Separate Cloud hand-off">The renderer posts oauth with the expected generation. The service records a scoped attempt and returns an installation or authorization URL. The renderer refreshes the snapshot, starts its ten-minute timer and opens the browser. A cloud callback consumes the attempt, exchanges the code, reads /user and saves against the expected generation. An installation-only return can instead report updated. On focus the renderer reads status and a changed generation clears the wait. <Cite path={settingsPath+"cloud-github-section.tsx"} line={134} end={151}/> · <Cite path={cloudPath+"github-connection-routes.ts"} line={50} end={61}/> · <Cite path={cloudPath+"github-connections.ts"} line={282} end={312}/> · <Cite path="apps/control-plane/src/github.ts" line={1017} end={1032}/> · <Cite path={cloudPath+"github-connections.ts"} line={320} end={366}/></Entry>
 <Entry title="1 · No completion reached Alpha">“Grant Zeros access in GitHub” starts an installation attempt even for an already configured App. Returning from an existing installation’s settings without a callback can leave the renderer waiting for a generation change. Check which action started the attempt, where the browser stopped, and whether Alpha received a callback before expiry. A callback with setup_action=update and no code takes the separate “updated” path. <Cite path={settingsPath+"cloud-github-section.tsx"} line={274} end={283}/> · <Cite path={cloudPath+"github-connections.ts"} line={320} end={328}/> A successful start followed by no matching callback supports an interrupted browser flow or wrong destination. A matched successful callback rules that out. Use request metadata with query strings omitted. <Cite path={cloudPath+"github-connections.ts"} line={298} end={312}/> · <Cite path="apps/control-plane/src/github.ts" line={1004} end={1032}/></Entry>
 <Entry title="2 · Completion was not observed">If Alpha saved a new generation, compare it with the next status GET for the same user and organization and the time the app regained focus. A missing read, failed read, or stale generation until the timer fired supports this hypothesis. This adapter refreshes on focus and suppresses refresh errors. <Cite path={settingsPath+"cloud-github-section.tsx"} line={94} end={118}/> · <Cite path={cloudPath+"github-connection-routes.ts"} line={24} end={35}/></Entry>
 <Entry title="3 · Callback could not save">If a callback arrived, check its result category, exchange result, account lookup result and expected-generation match. An expired or superseded attempt, denial, or exchange failure with no credential save explains an unsuccessful sign-in. To explain the timer too, check whether the renderer saw the retired generation. An installation-only “updated” result also needs distinguishing from “connected”. <Cite path={cloudPath+"github-connections-store.ts"} line={402} end={450}/> · <Cite path={cloudPath+"github-connections.ts"} line={320} end={365}/></Entry>
 <Entry title="Unified adapter reference for other attempts">Check the browser’s return to the Alpha desktop scheme and the presence and result of its exchange request. A callback followed by no exchange, an expired handoff, or a generation conflict distinguishes these failures. Record only stage, status, timing and build identifiers. The separate adapter’s timer cannot establish a unified-exchange failure. <Cite path="apps/desktop/electron/github-app-controller.ts" line={309} end={341}/> · <Cite path="apps/control-plane/src/github.ts" line={1414} end={1445}/> · <Cite path="apps/control-plane/src/github.ts" line={1482} end={1495}/></Entry>
 </article>:tab==="proposed"?<article><h2>Release scope</h2>
 <Entry title="First release · Re-skin">Offer one entry for initial setup, inline Local and owner-scoped Cloud method selectors, device-only CLI and a separate disconnect action. Group installations by ownership. Link reuses an installation, Install and Reinstall hand off to GitHub. Refresh returns the caller-visible grants. Keep the existing project visibility and personal-projects switch. Solo and unavailable variants use existing capability and ownership distinctions.</Entry>
 <Entry title="First release · New backend work">Enforce a single GitHub identity across App and PAT writes, including races and alternate entry points. Verify token identity before saving. The existing /user lookup provides the reported login. <Cite path={cloudPath+"github-connections.ts"} line={251} end={271}/>  The cross-method identity rule needs enforcement by stable GitHub user ID. Installation discovery with a token selected uses an explicit switch to GitHub App in this preview.</Entry>
 <Entry title="First release backend work · Project visibility">The shipped list returns every organization project and its repository names to every organization member, plus the caller’s own personal projects. A member can therefore learn a repository name through a project before the workspace-create check. Hiding these names would require filtering the list and detail responses on the server. <Cite path={cloudPath+"projects.ts"} line={108} end={134}/> · <Cite path={cloudPath+"projects.ts"} line={137} end={145}/></Entry>
 <Entry title="Access comparison">The caller’s own effective-access readout is a re-skin. Admin comparisons across linked members require new authorized per-member queries. Ordinary members see only their own rights. In a personal connection only the owner appears. There is no independent mirror job or enable switch.</Entry>
 <Entry title="Later · New backend work">Store multiple GitHub accounts and their method credentials per scope. Bind links to the acting account. Preview credential loss and link changes before activation. Pausing running cloud workspaces during an account switch is proposed lifecycle work. The example simulates that pause.</Entry>
 <Entry title="Later · New backend work">Persist and enforce repository audience limits, a Zeros subset within GitHub’s grant, connection labels and delegated configure/share permissions. A personally owned installation used at organization scope needs separate logical grants to preserve the private inventory. Today promotion can rebind rows. Filter shared project discovery by all repositories in Later. GitHub remains authoritative for installation changes. <Cite path={cloudPath+"repository-levels.ts"} line={87} end={108}/></Entry>
 <Entry title="Changes from the earlier study">Multiple accounts, personal accounts at organization scope, per-repository audiences and delegated access move to Later. The earlier organization-only mirroring control is retired. Its GitHub / In Zeros comparison is available in both releases. Personal connections remain owner-only.</Entry>
 </article>:<article><section className="preview-launch"><h2>Open an example</h2><p>Examples reset sample data. Switching release loads that release’s initial data.</p><div className="account-list">{examples.map(([key,label])=><ListRow key={key} className="method-option" onClick={()=>launch(key)}><span className="grow">{label}</span><G n="chev"/></ListRow>)}</div></section>
 <Entry title="Account switch">The saved-account example opens Later with Cloud on a token. Choose the work account beside Authentication methods to inspect the impact. Cancel preserves both selections. Confirm applies it.</Entry>
 <Entry title="Private projects">Switch between Arun and Maya. Each can discover organization projects in First release. Only the owner sees a personal project. In Later an organization repository audience can restrict shared project discovery.</Entry>
 <Entry title="Verification boundary">Every account, token response, installation hand-off, pause and permission shown here is simulated in memory. Reloading resets the sample. The study used pinned source and screenshots. No live Alpha trace establishes a cause for the reported timeout.</Entry></article>}</div>;
}

function AccountList({rows,user,open,needsLink,link,installs,restore}){
  const {eligible,access,hasLink}=React.useContext(AccessModel);
  const {later}=React.useContext(Preview);
  if (!rows.length) return <div className="account-list empty">No GitHub accounts connected. Add your first connection to select repositories.</div>;
  return <div className="account-list">{rows.map(c=>{
    const count=(later?Object.keys(c.repos):(installs[c.owner]||[])).filter(r=>installs[c.owner]?.includes(r)&&hasLink(c,user)&&access(r,user)&&(owns(c,user)||eligible(c,r,user))).length;
    const privateScope=c.scope!=="org";
    const action=!installs[c.owner]?(owns(c,user)?"Reinstall":null):needsLink(c)?"Link":null;
    return <div key={c.id} className="account-with-action"><ListRow className="account-item" onClick={()=>open(c.id)}>
      <span className="account-names"><span className="account-login">@{c.owner}</span><small>{c.label?c.label+" · ":""}github.com · {count} {count===1?"repository":"repositories"}</small></span>
      <span className="account-audience"><G n={privateScope?"lock":"group"}/>{privateScope?"Only you":"Withso"}</span>{!action&&<G n="chev"/>}
    </ListRow>{action&&<Button size="compact" aria-label={action+" @"+c.owner} onClick={()=>action==="Link"?link(c):restore(c)}>{action}</Button>}</div>;
  })}</div>;
}
function ConnectionGroups({rows,...props}){
 return <>{[["org","Withso"],[props.user,"Only you"]].map(([scope,title])=><section className="grouped-connections" aria-label={title} key={scope}>
   <h3>{title}</h3><AccountList {...props} rows={rows.filter(c=>c.scope===scope)}/></section>)}</>;
}
function GithubOverview({rows,user,allowed,setAllowed,open,detail,configureIdentity,link,needsLink,installs,restore}){
  return <div className="github-overview">
    <header className="integration-title"><h1><GitHubMark size={24}/>GitHub</h1>
      <p>Connect repositories to Zeros and choose who can use them. <a href="https://docs.github.com/en/apps/using-github-apps/installing-a-github-app-from-a-third-party" target="_blank" rel="noreferrer">GitHub documentation<ArrowUpRight size={12}/></a></p>
    </header>
    <section className="integration-section"><div className="section-line">
      <div><h2>Connections</h2><p>Your personal and organization GitHub accounts.</p></div>
      <Button variant="primary" onClick={()=>open({type:"add",scope:user})}><Plus/>Add connection</Button>
    </div><ConnectionGroups rows={rows} user={user} open={detail} link={link} needsLink={needsLink} installs={installs} restore={restore}/></section>
    <section className="integration-section"><h2>General</h2>
      {admin(user)&&<div className="setting-surface"><SettingsRow label={<label htmlFor="enable-private">Allow personal projects</label>} hint="Let members create private projects from their own GitHub accounts."><Switch id="enable-private" aria-label="Allow personal projects" checked={allowed} onCheckedChange={setAllowed}/></SettingsRow></div>}
      <div className="setting-links">
        <Button variant="ghost" onClick={configureIdentity}>Configure account identity<ArrowUpRight/></Button>
      </div>
    </section>
  </div>;
}
function Product(){
 const [release,setRelease]=useState("first"),[variant,setVariant]=useState("withso");
 const later=release==="later",solo=variant==="solo",signedOut=variant==="signed-out";
 const cloud=["withso","solo"].includes(variant),ownerKey=cloud?"withso":signedOut?"signed-out":"device";
 const [provider,setProvider]=useState(true);
 const [user,setUser]=useState("arun"),[mode,setMode]=useState("prototype"),[page,setPage]=useState("integrations"),[panel,open]=useState(null),[note,setNote]=useState("");
 const [cs,setCs]=useState(seedConnections),[projects,setProjects]=useState(seedProjects),[allowed,setAllowed]=useState(true);
 const [installs,setInstalls]=useState(seedInstalls);
 const seedScopes=()=>({withso:{...initialIdentities},device:{...initialIdentities},"signed-out":{arun:makeIdentity("arun",false,true),maya:makeIdentity("maya",false,true)}});
 const [scopes,setScopes]=useState(seedScopes);
 const accountStates=scopes[ownerKey];
 const identities=Object.fromEntries(Object.entries(accountStates).map(([id,state])=>[id,identityView(state)]));
 const changeAccount=update=>setScopes(prev=>({...prev,[ownerKey]:{...prev[ownerKey],[user]:update(prev[ownerKey][user])}}));
 const rules=buildAccessModel(identities,installs,later,solo),{canSeeProject}=rules;
 const who=people[user],method=identities[user],orgRows=cs.filter(c=>c.scope==="org"),ownRows=cs.filter(c=>c.scope===user);
 const shown=projects.filter(p=>canSeeProject(p,user,cs)),close=()=>open(null),finish=msg=>{setNote(msg);close()},go=p=>{setPage(p);setNote("");close()};
 const navigate=(p,inside=false)=>{setProvider(inside);go(p)};
 const setUserView=v=>{setUser(v);setNote("");close()};
 const c=panel?.type==="detail"?cs.find(c=>c.id===panel.id):null,p=panel?.type==="project"?shown.find(p=>p.id===panel.id):null;
 const [light,setLight]=useState(false);useEffect(()=>{document.documentElement.dataset.theme=light?"light":"dark";},[light]);
 function selectContext(next){
   setVariant(next);setUser(next==="solo"?"arun":user);navigate("integrations",true);
 }
 function selectRelease(value){
   if(value===release)return;
   setRelease(value);setCs(seedConnections);setInstalls(seedInstalls);setScopes(seedScopes());setProjects(seedProjects);setAllowed(true);setNote("");close();
 }
 function launchExample(example){
   const seed=seedScopes(),methods=seed.withso;
   const installations={...seedInstalls};
   if(example==="methods"){
     const s=saveCredential(saveCredential(methods.arun,"app","arun-withso"),"pat",people.arun.login);
     methods.arun={...s,workspaceMethods:{local:"app",cloud:"pat"}};
   }
   if(["disconnected","new-install","link"].includes(example))methods.arun=makeIdentity("arun",false,example!=="disconnected");
   if(example==="pat-link")methods.arun={...makeIdentity("arun"),accounts:[{method:"pat",login:people.arun.login}],workspaceMethods:{local:"pat",cloud:"pat"}};
   if(example==="reinstall")delete installations.Withso;
   const context=["unavailable","signed-out","solo","personal"].includes(example)?example:"withso";
   const personal=["methods","disconnected","unavailable","signed-out","solo","personal"].includes(example);
   setRelease(example==="methods"?"later":"first");setVariant(context);
   setMode("prototype");setUser("arun");setPage(personal?"integrations":"connections");setProvider(true);
   setCs(example==="pat-link"?seedConnections.map(c=>c.scope==="org"?{...c,linked:{arun:[]}}:c):seedConnections);setInstalls(installations);setScopes(seed);setProjects(seedProjects);setAllowed(true);setNote("");
   if(example==="new-install"||example==="existing")open({type:"add",scope:"org",owner:example==="existing"?"Northstar":"Studio-Labs"});
   else if(example==="pat-link")open({type:"link",id:"withso"});
   else close();
 }
 const recordInstall=(owner,repos)=>setInstalls(prev=>({...prev,[owner]:repos}));
 const authorize=login=>changeAccount(state=>{
   if(state.sharedLogin&&state.sharedLogin!==login)return state;
   const saved=saveCredential(state,"app",login);
   return {...saved,sharedLogin:login,workspaceMethods:{local:state.workspaceMethods.local||(!state.accounts.length?"app":null),cloud:"app"}};
 });
 const needsLink=(conn,identity=method)=>!accountIsLinked(conn,user,identity);
 const detail=id=>{setNote("");open({type:"detail",id})};
 useEffect(()=>{document.title="GitHub connections · Zeros"},[]);
 return <Preview.Provider value={{release,later,cloud,solo,signedOut,variant}}><AccessModel.Provider value={rules}><PageLayout><div className="studio"><header className="mast"><div className="brand"><span className="brandmark" aria-hidden dangerouslySetInnerHTML={{__html:logo}}/><span>Zeros</span><span className="mastname">Settings</span></div><div className="reviewtools"><div className="release-control"><span>Release</span><Seg label="Release" value={release} set={selectRelease} items={[["first","First release"],["later","Later"]]}/></div><Seg label="Preview mode" value={mode} set={v=>{setMode(v);close()}} items={[["prototype","Prototype"],["notes","Design notes"]]}/>{mode==="prototype"&&<Picker label="Preview as" value={user} items={solo?[["arun","Arun · Admin"]]:[["arun","Arun · Admin"],["maya","Maya · Member"]]} set={setUserView}/>}<Button variant="ghost" size="icon" aria-label={light?"Use dark appearance":"Use light appearance"} onClick={()=>setLight(!light)}>{light?<Moon/>:<Sun/>}</Button></div></header>
 {mode==="notes"?<Notes launch={launchExample}/>:<div className="shell"><aside className="rail"><div className="org flexline"><div className="context-select"><small>Settings context</small><Picker quiet label="Settings context" value={variant} set={selectContext} items={[["withso","Withso"],["personal","Personal"],["solo","Withso · Solo"],["unavailable","Cloud projects unavailable"],["signed-out","Signed-out Local"]]}/></div></div><nav aria-label="Personal"><div className="caption">Personal</div><Button variant="ghost" className={"navitem "+(page==="integrations"?"active":"")} onClick={()=>navigate("integrations")}><G n="person"/>Integrations</Button></nav>{cloud&&<nav aria-label="Organization"><div className="caption">Organization</div>{Object.keys(names).map(k=><Button variant="ghost" key={k} aria-current={page===k?"page":undefined} className={"navitem "+(page===k?"active":"")} onClick={()=>navigate(k)}><G n={k==="connections"?"link":"folder"}/>{names[k]}</Button>)}</nav>}<div className="railuser flexline"><span className="avatar">{who.initials}</span><div><strong>{who.name}</strong><small>{who.role}</small></div></div></aside><main className={"content "+page+"-page"} data-popover-boundary="">{(page==="connections"||page==="integrations")&&provider&&<div className="backstrip"><Button variant="ghost" size="compact" onClick={()=>navigate(page)}><ArrowLeft/>Back to {page==="integrations"?"Integrations":"Connections"}</Button></div>}<div className="reading">{note&&<div className="notice" role="status">{note}</div>}
 {page==="integrations"?(provider?<React.Fragment key={[release,variant,user].join("-")}><PersonalGitHub user={user} methods={method} change={changeAccount} connections={[...orgRows,...ownRows]} installs={installs} needsLink={needsLink}/>{solo&&<section className="integration-section"><h2>Connections</h2><ConnectionGroups rows={[...orgRows,...ownRows]} user={user} open={detail} needsLink={needsLink} link={conn=>open({type:"link",id:conn.id})} installs={installs} restore={conn=>open({type:"add",scope:conn.scope,owner:conn.owner,restoreId:conn.id})}/><Button onClick={()=>open({type:"add",scope:user})}>Add connection</Button></section>}</React.Fragment>:<IntegrationDirectory methods={method} configure={()=>setProvider(true)}/>):page==="connections"&&!provider?<><div className="title"><h1>Connections</h1></div><section className="block"><Heading title="Git providers" desc="Connect your codebase to Zeros."/><div className="inventory provider-list"><ListRow className="provider-row" onClick={()=>{setProvider(true);setNote("")}}><GitHubMark size={23}/><span className="grow"><strong>GitHub</strong><small className={orgRows.length||ownRows.length?"connected":""}>{orgRows.length||ownRows.length?"Connected":"Not connected"}</small></span><span className="configure">Configure</span><G n="chev"/></ListRow></div></section></>:page==="connections"?<GithubOverview rows={[...ownRows,...orgRows]} user={user} allowed={allowed} setAllowed={setAllowed} open={open} detail={detail} configureIdentity={()=>navigate("integrations",true)} link={conn=>open({type:"link",id:conn.id})} needsLink={needsLink} installs={installs} restore={conn=>owns(conn,user)?open({type:"add",scope:conn.scope,owner:conn.owner,restoreId:conn.id}):setNote("A Withso admin needs to restore this GitHub installation.")}/>
 :<><div className="between title"><div><h1>Projects</h1><p>Choose repositories for a cloud workspace and decide who can open the project.</p></div><Button variant="primary" disabled={!allowed&&!admin(user)} onClick={()=>open({type:"new"})}><G n="plus" size={14}/>New project</Button></div>{!allowed&&<p className="notice warn">Withso has paused new personal projects. Existing personal projects stay private.</p>}{[["org","Organization projects"],[user,"Only you"]].map(([scope,title])=><section key={scope} className="block"><Heading title={title} desc={scope==="org"?(later?"Projects whose repositories you can use.":"Projects visible to Withso members."):"Your private projects, including those built from organization repositories."}/><div className="box">{shown.filter(p=>p.scope===scope).map(p=><Button variant="ghost" key={p.id} className="source" onClick={()=>open({type:"project",id:p.id})}><span className="tile"><G n="folder"/></span><span className="grow"><strong>{p.name}</strong><small>{p.repos.join(", ")}</small></span><Scope scope={p.scope}/><G n="chev" size={15}/></Button>)}{!shown.some(p=>p.scope===scope)&&<div className="pad muted">No {scope==="org"?"eligible organization":"personal"} projects yet.</div>}</div></section>)}</>}</div></main></div>}
 {panel?.type==="link"&&<LinkInstallation connection={cs.find(x=>x.id===panel.id)} methods={method} user={user} authorize={authorize} close={close} done={id=>{setCs(cs.map(c=>c.id===panel.id?{...c,linked:{...c.linked,[user]:[...new Set([...(c.linked?.[user]||[people[user].login]),id])]}}:c));detail(panel.id);setNote("Linked to the existing installation.")}}/>}
 {panel?.type==="add"&&<AddConnection methods={method} authorize={authorize} installs={installs} recordInstall={recordInstall} initialOwner={panel.owner} restore={Boolean(panel.restoreId)} user={user} scope={panel.scope} connections={cs} close={close} save={incoming=>{
   if(panel.restoreId)setCs(cs.map(old=>old.id===panel.restoreId?{...old,repos:Object.fromEntries(Object.keys(incoming.repos).map(repo=>[repo,old.repos[repo]||incoming.repos[repo]]))}:old));
   else setCs([...cs,{...incoming,linked:{[user]:[method.sharedLogin]}}]);
   finish("@"+incoming.owner+" connected "+(incoming.scope==="org"?"to Withso.":"for you only."));
 }}/>}
 {c&&<ConnectionDetail initialTab={panel.tab} installedRepos={installs[c.owner]||[]} installed={Boolean(installs[c.owner])} linked={!needsLink(c)} user={user} c={c} cs={cs} projects={projects} close={close} recordInstall={recordInstall} update={rec=>setCs(cs.map(s=>s.id===rec.id?rec:s))} remove={id=>{setCs(cs.filter(s=>s.id!==id));finish("Connection removed.")}}/>}
 {(panel?.type==="new"||p)&&<ProjectForm user={user} cs={cs} projects={projects} project={p} allowed={allowed} close={close} save={v=>{setProjects([...projects,v]);finish("Created "+v.name+".")}} promote={()=>{setProjects(projects.map(x=>x.id===p.id?{...x,scope:"org"}:x));finish(p.name+" shared with eligible Withso members.")}}/>}</div></PageLayout></AccessModel.Provider></Preview.Provider>
}
createRoot(document.getElementById("root")).render(<Product/>);
