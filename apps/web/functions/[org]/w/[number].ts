import {parseWorkspacePagePath,renderWorkspacePage,workspacePageSession} from "../../../lib/workspace-page.mjs";
import {deploymentAppLink} from "../../../lib/schemes.mjs";
import {marketingOrigin} from "../../../lib/hosts";
import type {Env} from "../../../lib/session";
// A cloud workspace's shareable page: app.zeros.build/<organization ID>/w/<n>,
// and a chat in it with ?session=<chat id>. It opens Zeros at once.
export const onRequestGet:PagesFunction<Env>=({request,params,env})=>{
  const address=typeof params.org==="string"&&typeof params.number==="string"?parseWorkspacePagePath(`/${params.org}/w/${params.number}`):null;
  const {ok,session}=workspacePageSession(new URL(request.url).searchParams);
  if(!address||!ok)return new Response("Not found",{status:404});
  // A stale deployment binding must not open some other app at this address.
  const appLink=deploymentAppLink(env.ZEROS_DEPLOY_ENV);
  if(!appLink)return new Response("This deployment is misconfigured.",{status:503});
  const page=renderWorkspacePage({address,session,appLink,nonce:crypto.randomUUID().replaceAll("-",""),marketingOrigin:marketingOrigin(env)});
  return new Response(page.html,{headers:page.headers});
};
