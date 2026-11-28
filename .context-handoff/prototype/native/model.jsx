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
