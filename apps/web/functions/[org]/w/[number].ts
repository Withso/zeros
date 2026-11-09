import {parseWorkspacePagePath, renderWorkspacePage} from "../../../lib/workspace-page.mjs";
import {deploymentAppLink} from "../../../lib/schemes.mjs";
import type {Env} from "../../../lib/session";
// A cloud workspace's shareable page: app.zeros.build/<organization slug>/w/<n>.
export const onRequestGet:PagesFunction<Env>=({params,env})=>{
  const address=typeof params.org==="string"&&typeof params.number==="string"?parseWorkspacePagePath(`/${params.org}/w/${params.number}`):null;
  if(!address)return new Response("Not found",{status:404});
  const page=renderWorkspacePage({address,appLink:deploymentAppLink(env.ZEROS_DEPLOY_ENV),nonce:crypto.randomUUID().replaceAll("-","")});
  return new Response(page.html,{headers:page.headers});
};
