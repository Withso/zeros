import {randomBytes} from "node:crypto";
import pg from "pg";
import {afterAll,beforeAll,beforeEach,describe,expect,it} from "vitest";
import {runMigrations} from "../migrate.js";
import {withSystemTx} from "../db.js";
import {seedReadyCloudWorkspace} from "./test-fixtures.js";
import {DatabaseCloudWorkspaceBlobService,MemoryCloudWorkspaceObjectStore} from "./object-store.js";

const d=process.env.TEST_DATABASE_URL?describe:describe.skip;
d("object reads across external storage latency",()=>{
  let pool:pg.Pool,blobs:DatabaseCloudWorkspaceBlobService,store:MemoryCloudWorkspaceObjectStore;
  let fixture:Awaited<ReturnType<typeof seedReadyCloudWorkspace>>,blobId:string;
  beforeAll(()=>{pool=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL,max:4});});
  afterAll(async()=>{await pool.end();});
  beforeEach(async()=>{
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');await runMigrations(pool);
    fixture=await seedReadyCloudWorkspace(pool);store=new MemoryCloudWorkspaceObjectStore();
    blobs=new DatabaseCloudWorkspaceBlobService({pool,objectStore:store,encryptionKeyV1:randomBytes(32).toString('base64url'),workosEnabled:false});
    blobId=(await blobs.putCoordinator({organizationId:fixture.organizationId,workspaceId:fixture.workspaceId,bytes:Buffer.from('private fixture bytes')})).id;
  });
  function pause(){
    let started!:()=>void,resume!:()=>void;
    const downloading=new Promise<void>(resolve=>{started=resolve;}),released=new Promise<void>(resolve=>{resume=resolve;});
    const get=store.get.bind(store);store.get=async key=>{started();await released;return get(key);};
    return{downloading,resume};
  }
  it.each([false,true])('releases database row locks while fetching, including deletion=%s',async(remove)=>{
    const paused=pause();
    const reading=blobs.getSystem({blobId,organizationId:fixture.organizationId});
    const result=Promise.allSettled([reading]);
    try{
      await paused.downloading;
      await withSystemTx(pool,async tx=>{
        await tx.query("SET LOCAL lock_timeout='250ms'");
        await tx.query('SELECT id FROM workspace_blobs WHERE id=$1 FOR NO KEY UPDATE',[blobId]);
        if(remove)await tx.query("UPDATE workspace_blobs SET state='deleting' WHERE id=$1",[blobId]);
      });
    }finally{paused.resume();await result;}
    if(remove)await expect(reading).rejects.toMatchObject({code:'object_unavailable'});
    else expect(await reading).toEqual(Buffer.from('private fixture bytes'));
  });
});
