export type CodexFingerprintKeys={keys:Readonly<Record<number,string>>;currentKeyVersion:number};
/** Security fingerprints outlive erased account associations. Their keyring is
 * separate from encryption so retiring ciphertext keys remains possible. */
export function loadCodexFingerprintKeys(env:Record<string,string|undefined>):CodexFingerprintKeys|undefined{
  const encoded=env.CLOUD_CODEX_REFRESH_FINGERPRINT_KEYS_JSON,current=env.CLOUD_CODEX_REFRESH_FINGERPRINT_CURRENT_KEY_VERSION;
  if(!encoded&&!current)return undefined;
  try{
    if(!encoded||encoded.length>4096||!current||!/^\d{1,5}$/.test(current))throw new Error();
    const value:unknown=JSON.parse(encoded),keys:Record<number,string>={};
    if(!value||typeof value!=="object"||Array.isArray(value)||Object.keys(value).length<1||Object.keys(value).length>32)throw new Error();
    for(const [version,key]of Object.entries(value)){
      if(!/^[1-9][0-9]{0,4}$/.test(version)||Number(version)>65535||typeof key!=="string"||!/^[A-Za-z0-9_-]{43}$/.test(key))throw new Error();
      const bytes=Buffer.from(key,"base64url");try{if(bytes.length!==32||bytes.toString("base64url")!==key)throw new Error();}finally{bytes.fill(0);}
      keys[Number(version)]=key;
    }
    if(!keys[Number(current)])throw new Error();return {keys,currentKeyVersion:Number(current)};
  }catch{throw new Error("Invalid cloud Codex refresh fingerprint keyring");}
}
