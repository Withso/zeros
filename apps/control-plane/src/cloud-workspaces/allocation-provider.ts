import type pg from "pg";
import { withSystemTx } from "../db.js";
import { lockCloudWorkspaceGenerationTransition } from "./generation-transitions.js";
import { CloudProviderError, assertProviderResourceIdentity, type CloudProviderResource, type CloudWorkspaceProvider } from "./provider.js";

type Scope = {workspaceId:string;organizationId:string;generation:number};
const rejected = () => new CloudProviderError("provider_generation_superseded","Allocation authority is not current",false);

/** Provider labels and allocation receipts retain their original generation.
 * This adapter projects only the exact audited allocation onto its live owner.
 * Every destructive call journals before I/O, so an expired worker lease never
 * makes a still-running provider request safe to race with an engine transfer. */
export function bindCloudAllocationProvider<T extends CloudWorkspaceProvider>(pool:pg.Pool,provider:T,scope:Scope):T {
  const owner = async (resourceId?:string) => withSystemTx(pool,async tx=>(await tx.query<{
    provider_resource_id:string;original_generation:number;current_generation:number;
  }>(`SELECT provider_resource_id,original_generation,current_generation FROM cloud_workspace_allocation_owners
    WHERE workspace_id=$1 AND org_id=$2 AND ($3::text IS NULL AND current_generation=$4 OR provider_resource_id=$3)`,
  [scope.workspaceId,scope.organizationId,resourceId??null,scope.generation])).rows[0]);
  const map = async (resource:CloudProviderResource|null) => {
    if (!resource) return null;
    const allocation=await owner(resource.resourceId);
    if (!allocation) return resource;
    assertProviderResourceIdentity(resource,{workspaceId:scope.workspaceId,generation:allocation.original_generation});
    if (allocation.current_generation!==scope.generation) throw rejected();
    return {...resource,generation:allocation.current_generation};
  };
  const mutate = async (operation:"start"|"stop"|"archive"|"delete",resourceId:string,call:()=>Promise<unknown>) => {
    const id=await withSystemTx(pool,async tx=>{
      await lockCloudWorkspaceGenerationTransition(tx,scope);
      const invalid=await tx.query(`SELECT 1 FROM cloud_workspace_allocation_owners WHERE workspace_id=$1 AND org_id=$2
        AND provider_resource_id=$3 AND current_generation<>$4
        UNION ALL SELECT 1 FROM cloud_workspace_runtime_transitions WHERE workspace_id=$1 AND org_id=$2
          AND phase IN ('activated','enrolling','checking','rolling_back','rollback_enrolling','rollback_checking')`,
      [scope.workspaceId,scope.organizationId,resourceId,scope.generation]);
      if (invalid.rowCount) throw rejected();
      return (await tx.query<{id:string}>(`INSERT INTO cloud_workspace_allocation_operations(workspace_id,org_id,generation,provider_resource_id,operation)
        VALUES($1,$2,$3,$4,$5) RETURNING id`,[scope.workspaceId,scope.organizationId,scope.generation,resourceId,operation])).rows[0]!.id;
    });
    try {
      const result=await call();
      await withSystemTx(pool,tx=>tx.query(`UPDATE cloud_workspace_allocation_operations SET state='completed',completed_at=clock_timestamp() WHERE id=$1`,[id]));
      return result;
    } catch(error) {
      await withSystemTx(pool,tx=>tx.query(`UPDATE cloud_workspace_allocation_operations SET state='uncertain' WHERE id=$1`,[id]));
      throw error;
    }
  };
  // Preserve optional compute/access methods and their private receiver. The
  // wrapper never changes original identities in provider-owned journals.
  return new Proxy(provider,{get(target,key) {
    if (key==='find') return async (identity:Scope)=>{
      const allocation=await owner();
      const resources=await target.find({...identity,generation:allocation?.original_generation??identity.generation});
      return Promise.all(resources.map(resource=>map(resource)));
    };
    if (key==='inspect') return async (id:string)=>map(await target.inspect(id));
    if (key==='verifyAbsence' && target.verifyAbsence) return async (identity:Scope)=>{
      const allocation=await owner();
      return target.verifyAbsence!({...identity,generation:allocation?.original_generation??identity.generation});
    };
    if (key==='start'||key==='stop'||key==='archive'||key==='delete') return async (id:string)=>{
      const result=await mutate(key,id,()=>target[key](id));
      return key==='delete'?undefined:map(result as CloudProviderResource);
    };
    const value=Reflect.get(target,key,target);
    if (key==='startWithComputeLease' && typeof value==='function') return async (id:string,...args:unknown[])=>
      map(await mutate('start',id,()=>value.call(target,id,...args)) as CloudProviderResource);
    return typeof value==='function'?value.bind(target):value;
  }});
}
