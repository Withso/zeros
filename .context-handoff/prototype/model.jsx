const people = {
  arun:{name:"Arun",login:"iamarunrk",initials:"AR",role:"Admin"},
  maya:{name:"Maya",login:"maya-dev",initials:"MK",role:"Member"}
};
const catalog = {
  Withso:[["zeros",false,"write","write"],["design-system",false,"write","read"],["infrastructure",false,"write","write"],["release-tools",false,"write",null]],
  iamarunrk:[["portfolio",true,"write","read"],["0kit",false,"write",null],["zeros-archive",false,"write",null]],
  "arun-labs":[["type-study",false,"write",null]],
  "maya-dev":[["sketchbook",false,null,"write"],["components",true,"read","write"]],
  "Studio-Labs":[["patterns",true,"write","read"]]
};
const isPublic = repo => {const [owner,name]=repo.split("/");return catalog[owner]?.find(r=>r[0]===name)?.[1]};
const seedConnections = [
  {id:"withso",owner:"Withso",scope:"org",repos:{"Withso/zeros":"all","Withso/design-system":"all","Withso/infrastructure":"arun"}},
  {id:"arun-private",owner:"iamarunrk",scope:"arun",repos:{"iamarunrk/portfolio":"arun","iamarunrk/0kit":"arun"}}
];
const seedProjects = [
  {id:"zeros",name:"Zeros",scope:"org",repos:["Withso/zeros"]},
  {id:"site",name:"Personal website",scope:"arun",repos:["iamarunrk/portfolio"]}
];
const mkId=()=>Math.random().toString(36).slice(2);
const admin = user => user==="arun";
const owns = (c,user) => c.scope===user || (c.scope==="org"&&admin(user));
const AccessModel=React.createContext(null);
function buildAccessModel(identities){
  const access=(repo,user)=>{
    const [owner,name]=repo.split("/");
    if(identities[user].cloudLogin?.endsWith("-withso")&&owner!=="Withso")return null;
    return catalog[owner]?.find(r=>r[0]===name)?.[user==="arun"?2:3]||null;
  };
const eligible = (c,repo,user) => !!access(repo,user) && (c.scope===user || (c.scope==="org"&&["all",user].includes(c.repos[repo])));
const permitted = (cs,user,sharedOnly=false) => [...new Set(cs.filter(c=>!sharedOnly||c.scope==="org").flatMap(c=>Object.keys(c.repos).filter(r=>eligible(c,r,user))))];
const canSeeProject = (p,user,cs) => p.scope===user || (p.scope==="org" && p.repos.every(r=>permitted(cs,user,true).includes(r)));
return {access,eligible,permitted,canSeeProject}
}
const audienceName = v => v==="all"?"All Withso members":v==="arun"?"Arun only":"Maya only";
const names = {connections:"Connections",projects:"Projects"};
const glyphs={
 link:"M10 13a5 5 0 0 0 7 .1l3-3a5 5 0 0 0-7-7l-2 2 M14 11a5 5 0 0 0-7-.1l-3 3a5 5 0 0 0 7 7l2-2",
 org:"M3 21h18 M5 21V4h10v17 M15 9h4v12 M8 8h1m2 0h1M8 12h1m2 0h1M9 21v-5h3v5",
 lock:"M6 10h12a1 1 0 0 1 1 1v9H5v-9a1 1 0 0 1 1-1z M8 10V7a4 4 0 0 1 8 0v3 M12 14v2",
 person:"M16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0z M4 21a8 8 0 0 1 16 0",
 group:"M13.5 7a3.5 3.5 0 1 1-7 0 3.5 3.5 0 0 1 7 0z M3 20a7 7 0 0 1 14 0 M16 5a3 3 0 0 1 0 6m2 3a6 6 0 0 1 3 5",
 cloud:"M6.5 18h11a4.5 4.5 0 1 0-.9-8.9A6.5 6.5 0 1 0 6.5 18z",
 mac:"M4 5h16v12H4z M2 20h20",repo:"M5 4a2 2 0 0 1 2-2h12v18H7a2 2 0 0 1 0-4h12 M5 4v14 M9 5h6",
 folder:"M3 6h7l2 2h9v12H3z",chev:"m9 6 6 6-6 6",plus:"M12 5v14 M5 12h14",close:"m6 6 12 12 M6 18 18 6",shield:"m12 2 8 3v6c0 5-4.2 8.1-8 11-3.8-2.9-8-6-8-11V5z M8 11l3 3 5-6",book:"M3 4h7l2 2 2-2h7v15h-7l-2 2-2-2H3z M12 6v14",refresh:"M20 5v5h-5 M4 19v-5h5 M5 9a8 8 0 0 1 13-4l2 3 M4 16l2 3a8 8 0 0 0 13-4",branch:"M7 6v12 M7 14c7 0 9-3 9-7 M9 4a2 2 0 1 1-4 0 2 2 0 0 1 4 0z M18 5a2 2 0 1 1-4 0 2 2 0 0 1 4 0z M9 20a2 2 0 1 1-4 0 2 2 0 0 1 4 0z"
};
function G({n,size=17}){return <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d={glyphs[n]}/></svg>}
function Scope({scope}){return <span className={"scope "+(scope==="org"?"":"private")}><G n={scope==="org"?"group":"lock"} size={12}/>{scope==="org"?"Organization":"Only you"}</span>}
function Heading({title,desc,children}){return <div className="sectionhead"><div><h2>{title}</h2>{desc&&<p>{desc}</p>}</div>{children}</div>}
function Row({title,hint,children}){return <div className="settingsrow"><div className="grow"><h3>{title}</h3>{hint&&<small>{hint}</small>}</div>{children}</div>}
function Seg({value,items,set}){return <div className="seg">{items.map(([v,label])=><Button key={v} variant="ghost" className={"segment "+(v===value?"active":"")} aria-pressed={v===value} onClick={()=>set(v)}>{label}</Button>)}</div>}
function Picker({label,value,items,set,disabled=false}){return <select aria-label={label} value={value} disabled={disabled} onChange={e=>set(e.target.value)}>{items.map(([v,label])=><option value={v} key={v}>{label}</option>)}</select>}
function CheckList({items,chosen,set}){return <div className="box">{items.length?items.map(r=><label className="choice" key={r}><input type="checkbox" checked={chosen.includes(r)} onChange={e=>set(e.target.checked?[...chosen,r]:chosen.filter(x=>x!==r))}/><span className="grow repoName">{r}</span><small>{isPublic(r)?"Public":"Private"}</small></label>):<p className="empty">No eligible repositories.</p>}</div>}
function Drawer({label,close,children}){const ref=useRef(null);useEffect(()=>{const el=ref.current;el.showModal();return ()=>el.close()},[]);return <dialog ref={ref} aria-label={label} onCancel={e=>{e.preventDefault();close()}}><div className="between drawerhead"><span className="muted">{label}</span><IconButton variant="ghost" aria-label="Close panel" onClick={close}><G n="close"/></IconButton></div><div className="drawerbody">{children}</div></dialog>}
