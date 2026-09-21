// Synthetic opaque tokens for local tests only; no provider calls.
export function syntheticCodexCache(options:{account?:string;subject?:string;expiresAt?:number;refresh?:string}={}){
  const payload={iss:"https://auth.openai.com",sub:options.subject??"synthetic-subject",exp:options.expiresAt??Math.floor(Date.now()/1000)+3600,
    "https://api.openai.com/auth":{chatgpt_account_id:options.account??"synthetic-account",chatgpt_user_id:"synthetic-user"}};
  const jwt=Buffer.from('{"alg":"RS256"}').toString("base64url")+"."+Buffer.from(JSON.stringify(payload)).toString("base64url")+".synthetic_signature";
  return {auth_mode:"chatgpt" as const,OPENAI_API_KEY:null,tokens:{id_token:jwt,access_token:jwt,refresh_token:options.refresh??"synthetic-refresh-token-for-tests",account_id:options.account??"synthetic-account"},last_refresh:new Date().toISOString()};
}
