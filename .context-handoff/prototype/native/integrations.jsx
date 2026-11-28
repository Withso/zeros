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
