import {renderWorkspacePage} from "../../../lib/workspace-page.mjs";
import type {Env} from "../../../lib/session";
export const onRequestGet:PagesFunction<Env>=({params})=>{
  const workspaceId=params.workspace;
  if(typeof workspaceId!=="string"||!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(workspaceId))return new Response("Not found",{status:404});
  const page=renderWorkspacePage({workspaceId,nonce:crypto.randomUUID().replaceAll("-","")});
  return new Response(page.html,{headers:page.headers});
};
