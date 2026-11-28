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
