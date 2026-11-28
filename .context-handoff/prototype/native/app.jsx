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
