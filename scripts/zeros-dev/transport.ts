import { ALPHA_ORIGIN } from "./config";
import { ZerosDevError } from "./errors";

export async function boundedJson(response: Response, signal: AbortSignal, maxBytes=4*1024*1024): Promise<unknown> {
  if(Number(response.headers.get("content-length")??0)>maxBytes || !response.body)throw new ZerosDevError("bad_response");
  const reader=response.body.getReader(), chunks:Uint8Array[]=[];
  let size=0;
  try {
    for(;;){
      const next=await beforeDeadline(reader.read(),signal);
      if(next.done)break;
      size+=next.value.byteLength;if(size>maxBytes)throw new ZerosDevError("bad_response");chunks.push(next.value);
    }
    try{return JSON.parse(Buffer.concat(chunks,size).toString("utf8"));}catch{throw new ZerosDevError("bad_response");}
  }finally{void reader.cancel().catch(()=>{});}
}

export function beforeDeadline<T>(operation:Promise<T>,signal:AbortSignal):Promise<T>{
  return new Promise<T>((resolve,reject)=>{
    const abort=()=>reject(new ZerosDevError("deadline"));
    operation.then(value=>{signal.removeEventListener("abort",abort);resolve(value);},error=>{signal.removeEventListener("abort",abort);reject(error);});
    if(signal.aborted)abort();else signal.addEventListener("abort",abort,{once:true});
  });
}

export type JsonRequest = {method?:"GET"|"POST"|"PUT"|"DELETE";body?:unknown;token?:string;idempotencyKey?:string;signal?:AbortSignal;timeoutMs?:number};
export class AlphaTransport {
  constructor(readonly fetchImpl:typeof fetch=fetch){}
  async json(requestPath:string, input:JsonRequest={}):Promise<unknown>{
    if(!/^\/(?!\/)/.test(requestPath)||/[\\\r\n\0#]/.test(requestPath))throw new ZerosDevError("invalid_request");
    const url=new URL(requestPath,ALPHA_ORIGIN);
    if(url.origin!==ALPHA_ORIGIN)throw new ZerosDevError("invalid_request");
    const timeout=AbortSignal.timeout(input.timeoutMs??20_000);
    const signal=input.signal?AbortSignal.any([input.signal,timeout]):timeout;
    if(signal.aborted)throw new ZerosDevError("deadline");
    let response:Response;
    try{
      response=await beforeDeadline(this.fetchImpl(url.href,{
        method:input.method??"GET",redirect:"error",credentials:"omit",cache:"no-store",signal,
        headers:{accept:"application/json",...(input.token?{authorization:`Bearer ${input.token}`}:{ }),
          ...(input.body===undefined?{}:{"content-type":"application/json"}),...(input.idempotencyKey?{"idempotency-key":input.idempotencyKey}:{})},
        ...(input.body===undefined?{}:{body:JSON.stringify(input.body)}),
      }),signal);
    }catch{throw new ZerosDevError(signal.aborted?"deadline":"service_unavailable");}
    if(!response.ok){
      void response.body?.cancel().catch(()=>{});
      const retryAfter=Number(response.headers.get("retry-after"));
      throw new ZerosDevError(response.status===401?"auth_denied":response.status===403?"forbidden":response.status===404?"not_found":
        response.status===409?"operation_conflict":response.status===429?"rate_limited":"service_unavailable",response.status,
        response.status===429&&Number.isFinite(retryAfter)?Math.max(1000,Math.min(60_000,retryAfter*1000)):undefined);
    }
    return boundedJson(response,signal);
  }
}
