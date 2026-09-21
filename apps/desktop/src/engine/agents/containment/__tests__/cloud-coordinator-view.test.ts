import {describe,expect,it} from "vitest";
import {cloudCoordinatorArguments,cloudCoordinatorEnvironment} from "../cloud-coordinator-view.mjs";

it("carries explicit effort and fast settings without accepting credential or loader overrides",()=>{
  const env=cloudCoordinatorEnvironment({kind:"codex-api-key",apiKey:"synthetic-admitted-key"},"gpt-5.6-sol",{
    ZEROS_THINKING_EFFORT:"high",ZEROS_FAST_MODE:"1",OPENAI_API_KEY:"injected",NODE_OPTIONS:"injected",
  });
  expect(env).toMatchObject({ZEROS_THINKING_EFFORT:"high",ZEROS_FAST_MODE:"1",OPENAI_API_KEY:"synthetic-admitted-key"});
  expect(env).not.toHaveProperty("NODE_OPTIONS");
});
describe("private provider coordinator view",()=>{
  it("contains only one private HOME and scratch, with a fresh PID/proc view and fixed UID",()=>{
    const directory=`/run/zeros/coordinators/${"a".repeat(32)}`;
    const args=cloudCoordinatorArguments(directory,"/opt/zeros-runtime/bin/node",["/opt/zeros/host.cjs"]);
    const writable=args.flatMap((value,index)=>value==="--bind"?[args.slice(index+1,index+3)]:[]);
    expect(writable).toEqual([[`${directory}/home`,"/home/zeros-agent"],[`${directory}/scratch`,"/srv/zeros/workspace"]]);
    expect(args).toContain("--unshare-pid");expect(args.slice(args.indexOf("--proc"),args.indexOf("--proc")+2)).toEqual(["--proc","/proc"]);
    expect(args).not.toContain("--unshare-user");
    expect(args).toContain("--reuid=10004");expect(args).toContain("--regid=10004");
    expect(args).toContain("--bounding-set=-all");expect(args).toContain("--no-new-privs");
    expect(args[args.indexOf("--chdir")+1]).toBe("/");
    expect(args).toContain("--chdir=/srv/zeros/workspace");
    for(const target of ["/tmp","/dev/shm"]){
      const index=args.indexOf(target);
      expect(args.slice(index-5,index+1)).toEqual(["--perms","1777","--size","67108864","--tmpfs",target]);
    }
    for(const forbidden of ["/srv/zeros/state","/srv/zeros/home/agent","/run/zeros/engine","/etc/zeros","--setenv"])expect(args).not.toContain(forbidden);
    expect(()=>cloudCoordinatorArguments("/run/zeros/coordinators/../../engine","/usr/bin/node")).toThrow();
    expect(()=>cloudCoordinatorArguments(directory,"/srv/zeros/workspace/script")).toThrow();
  });
  it("uses explicit material and model without inheriting process-global credentials or configuration",()=>{
    const env=cloudCoordinatorEnvironment({kind:"cursor-api-key",apiKey:"synthetic-cursor-key"},"grok-4.6");
    expect(env.CURSOR_API_KEY).toBe("synthetic-cursor-key");expect(env.CURSOR_MODEL).toBe("grok-4.6");
    expect(Object.keys(env).sort()).toEqual(["CURSOR_API_KEY","CURSOR_MODEL","HOME","LANG","LOGNAME","PATH","SHELL","TMPDIR","USER","XDG_CACHE_HOME","XDG_CONFIG_HOME","XDG_DATA_HOME","ZEROS_REQUIRE_EXACT_MODEL","ZEROS_CURSOR_STATE_ROOT"].sort());
    const subscription=cloudCoordinatorEnvironment({kind:"codex-chatgpt",accessToken:"synthetic-access-token",accountId:"account",expiresAt:2000000000},"gpt-5.6-sol");
    expect(subscription.OPENAI_API_KEY).toBeUndefined();expect(Object.values(subscription)).not.toContain("synthetic-access-token");
    expect(()=>cloudCoordinatorEnvironment({kind:"cursor-api-key",apiKey:"synthetic-cursor-key"},"bad\nmodel")).toThrow();
  });
  it.each(["claude","cursor","codex"] as const)("binds only the exact %s transcript subtree",provider=>{
    const history={provider,directory:`/srv/zeros/state/native-agent-history/${"b".repeat(64)}/${provider}`};
    const args=cloudCoordinatorArguments(`/run/zeros/coordinators/${"a".repeat(32)}`,"/usr/bin/true",[],history);
    const target={claude:".claude/projects",cursor:".cursor/zeros-store",codex:".codex/sessions"}[provider];
    expect(args.slice(args.indexOf(history.directory)-1,args.indexOf(history.directory)+2)).toEqual(["--bind",history.directory,`/home/zeros-agent/${target}`]);
    expect(()=>cloudCoordinatorArguments(`/run/zeros/coordinators/${"a".repeat(32)}`,"/usr/bin/true",[],{...history,directory:"/srv/zeros/state"})).toThrow();
  });
});
