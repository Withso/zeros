import {createHash} from "node:crypto";
import {LspError} from "./lsp-rpc";
import type {LspDocument} from "./cloud-language-service";

export const CLOUD_LANGUAGE_FILE_HELPER="/opt/zeros/apps/desktop/src/engine/agents/containment/cloud-file-tool.mjs";
/** The helper opens each component through pinned directory descriptors with
 * O_NOFOLLOW inside the same workload boundary as the language server. */
export function parseLanguageDocument(output:string):LspDocument{
  let value:unknown;try{value=JSON.parse(output);}catch{throw new LspError();}
  const response=value as {ok?:unknown;data?:{encoding?:unknown;content?:unknown;sha256?:unknown;totalBytes?:unknown}};
  const data=response?.data;
  if(response?.ok!==true||!data||data.encoding!=="utf8"||typeof data.content!=="string"||
      typeof data.sha256!=="string"||Buffer.byteLength(data.content)>65536||data.totalBytes!==Buffer.byteLength(data.content)||
      createHash("sha256").update(data.content).digest("hex")!==data.sha256)throw new LspError("denied");
  return {text:data.content,sha256:data.sha256};
}
