import type { ChildProcess, SpawnOptions } from 'node:child_process';
import type { Duplex } from 'node:stream';
export function assertCloudSshEngineIdentity(identity:{platform:string;uid:number;gid:number}):void;
export interface CloudSshPty {
 write(data:string|Buffer):void;resize(cols:number,rows:number):void;kill(signal?:string):void;pause():void;resume():void;
 onData(callback:(data:string)=>void):unknown;onExit(callback:(event:{exitCode:number})=>void):unknown;
}
export function createCloudSshSession(stream:Duplex,options:{cwd:string;env:Record<string,string>;sftpServer?:string;
 spawnPty?:(command:string,args:string[],options:{cwd:string;env:Record<string,string>;cols?:number;rows?:number;name?:string})=>CloudSshPty|Promise<CloudSshPty>;
 spawnProcess?:(command:string,args:string[],options:SpawnOptions&{cwd:string;env:Record<string,string>})=>ChildProcess|Promise<ChildProcess>;
}):{publicKey:string;hostKeySha256:string;start():void;close():void};
