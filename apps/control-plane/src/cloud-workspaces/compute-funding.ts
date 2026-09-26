import {createHash,randomUUID,timingSafeEqual} from "node:crypto";
import type pg from "pg";
import {z} from "zod";
import {withSystemTx,type Tx} from "../db.js";
import {HttpError} from "../authz.js";
import {CloudProviderError} from "./provider.js";

const maximum=1_000_000_000_000;
const key=z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/);
const receiptSchema=z.object({userId:z.string().uuid(),startsAt:z.date(),endsAt:z.date(),amountMicroUsd:z.number().int().min(1).max(maximum),
  source:z.object({kind:z.enum(["operator","billing"]),id:key,lineItemId:key}).strict(),
  operator:z.object({actorUserId:z.string().uuid(),reason:z.string().min(16).max(512),targetFingerprint:z.string().regex(/^[a-f0-9]{64}$/)}).strict().optional(),
}).strict();
type Root={id:string;user_id:string;starts_at:Date;ends_at:Date;granted_micro_usd:string;allocated_micro_usd:string};
type Child={id:string;user_id:string;org_id:string;funding_period_id:string;funding_mode:string;
  granted_micro_usd:string;debited_micro_usd:string;reserved_micro_usd:string;returned_micro_usd:string};
function deny(code:string):never{throw new CloudProviderError(code,"Compute funding is unavailable or requires reconciliation",false);}
function money(value:string|number):number{const n=Number(value);if(!Number.isSafeInteger(n)||n<0||n>maximum)deny("compute_credit_invalid");return n;}
function available(row:Child):number{return money(row.granted_micro_usd)-money(row.debited_micro_usd)-money(row.reserved_micro_usd)-money(row.returned_micro_usd);}

/** Lock rank: user funding account, organization/workspace, child accounts,
 * periods, reservations. Never acquire this root while holding a child lock. */
export async function lockComputeUserFunding(tx:Tx,userId:string):Promise<void>{
  await tx.query("INSERT INTO managed_compute_user_accounts(user_id) VALUES ($1) ON CONFLICT DO NOTHING",[userId]);
  await tx.query("SELECT user_id FROM managed_compute_user_accounts WHERE user_id=$1 FOR UPDATE",[userId]);
}

/** Zero-value child periods make forecasting possible without moving funds.
 * Actual allocations occur in the same transaction as the reservation. */
export async function prepareComputeUserPeriods(tx:Tx,input:{userId:string;organizationId:string}):Promise<void>{
  const roots=(await tx.query<Root>(`SELECT * FROM managed_compute_user_periods WHERE user_id=$1
    AND ends_at>clock_timestamp() AND starts_at<clock_timestamp()+interval '2 hours' ORDER BY starts_at,id LIMIT 17`,[input.userId])).rows;
  if(!roots.length)return;
  await tx.query("INSERT INTO managed_compute_credit_accounts(org_id,user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING",[input.organizationId,input.userId]);
  for(const root of roots){
    const overlapping=(await tx.query<Child>(`SELECT * FROM managed_compute_credit_periods
      WHERE org_id=$1 AND user_id=$2 AND starts_at<$4 AND ends_at>$3`,[input.organizationId,input.userId,root.starts_at,root.ends_at])).rows;
    if(overlapping.length){
      if(overlapping.length!==1||overlapping[0]!.funding_period_id!==root.id)deny("compute_credit_legacy_funding_conflict");
      continue;
    }
    await tx.query(`INSERT INTO managed_compute_credit_periods(id,org_id,user_id,starts_at,ends_at,funding_mode,funding_period_id)
      VALUES ($1,$2,$3,$4,$5,'pro_user',$6)`,[randomUUID(),input.organizationId,input.userId,root.starts_at,root.ends_at,root.id]);
  }
}

async function movement(tx:Tx,child:Child,kind:"allocate"|"return",amount:number,operationKey:string):Promise<void>{
  await tx.query(`INSERT INTO managed_compute_funding_movements(id,operation_key,user_id,funding_period_id,child_period_id,kind,amount_micro_usd)
    VALUES ($1,$2,$3,$4,$5,$6,$7)`,[randomUUID(),operationKey,child.user_id,child.funding_period_id,child.id,kind,amount]);
  if(kind==='return'){
    await tx.query("UPDATE managed_compute_credit_periods SET returned_micro_usd=returned_micro_usd+$2,updated_at=now() WHERE id=$1",[child.id,amount]);
    await tx.query("UPDATE managed_compute_user_periods SET allocated_micro_usd=allocated_micro_usd-$2,updated_at=now() WHERE id=$1",[child.funding_period_id,amount]);
  }else{
    const hash=createHash('sha256').update(JSON.stringify([child.id,child.funding_period_id,amount,operationKey])).digest();
    await tx.query(`INSERT INTO managed_compute_credit_grants(id,period_id,org_id,user_id,idempotency_key,request_sha256,amount_micro_usd,policy_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,'pro-user-allocation-v1')`,[randomUUID(),child.id,child.org_id,child.user_id,operationKey,hash,amount]);
    await tx.query("UPDATE managed_compute_credit_periods SET granted_micro_usd=granted_micro_usd+$2,updated_at=now() WHERE id=$1",[child.id,amount]);
    await tx.query("UPDATE managed_compute_user_periods SET allocated_micro_usd=allocated_micro_usd+$2,updated_at=now() WHERE id=$1",[child.funding_period_id,amount]);
    await tx.query(`INSERT INTO managed_compute_credit_events(id,period_id,org_id,user_id,kind,amount_micro_usd)
      VALUES ($1,$2,$3,$4,'grant',$5)`,[randomUUID(),child.id,child.org_id,child.user_id,amount]);
  }
}

/** Caller holds the immutable payer's root. Returned child capacity is removed
 * before another org can reserve it. Active/uncertain holds are never moved. */
export async function allocateComputeUserFunding(tx:Tx,input:{periodId:string;userId:string;requiredAvailableMicroUsd:number}):Promise<void>{
  const desired=money(input.requiredAvailableMicroUsd);
  const target=(await tx.query<Child>("SELECT * FROM managed_compute_credit_periods WHERE id=$1 AND user_id=$2",[input.periodId,input.userId])).rows[0];
  if(!target||target.funding_mode!=='pro_user'||!target.funding_period_id)deny('compute_credit_user_funding_required');
  const root=(await tx.query<Root>("SELECT * FROM managed_compute_user_periods WHERE id=$1 AND user_id=$2 FOR UPDATE",[target.funding_period_id,input.userId])).rows[0];
  if(!root)deny('compute_credit_user_funding_required');
  const current=(await tx.query<Child>("SELECT * FROM managed_compute_credit_periods WHERE id=$1 FOR UPDATE",[target.id])).rows[0]!;
  const need=Math.max(0,desired-available(current));
  if(!need)return;
  let free=money(root.granted_micro_usd)-money(root.allocated_micro_usd);
  if(free<need){
    // Empty children are not locked. Bound the donor set so a single request
    // cannot monopolize the payer lock as organization history grows.
    const children=(await tx.query<Child>(`SELECT * FROM managed_compute_credit_periods
      WHERE funding_period_id=$1 AND user_id=$2 AND id<>$3
        AND granted_micro_usd-debited_micro_usd-reserved_micro_usd-returned_micro_usd>0
      ORDER BY org_id,id LIMIT 129 FOR UPDATE`,[root.id,input.userId,target.id])).rows;
    const donors=children.slice(0,128);
    if(need>free+donors.reduce((sum,child)=>sum+available(child),0)){
      if(children.length>128)deny('compute_credit_allocation_fragmented');
      deny('compute_credit_exhausted');
    }
    for(const child of donors){
      if(free>=need)break;
      const amount=Math.min(available(child),need-free);
      if(amount>0){await movement(tx,child,'return',amount,`return:${randomUUID()}`);free+=amount;}
    }
  }
  if(need>free)deny('compute_credit_exhausted');
  // Bound cumulative child movement separately from the root's net balance.
  if(money(current.granted_micro_usd)+need>maximum)deny('compute_credit_invalid');
  await movement(tx,current,'allocate',need,`allocate:${randomUUID()}`);
}

/** Trusted funding boundary, not a public billing endpoint. Receipt identity
 * is global across users and organizations; changing its owner is a conflict. */
export class DatabaseComputeUserFunding {
  constructor(private readonly pool:pg.Pool){}
  async fund(input:z.input<typeof receiptSchema>):Promise<{periodId:string;replayed:boolean}>{
    const parsed=receiptSchema.safeParse(input);if(!parsed.success)deny('compute_credit_invalid');
    const request=parsed.data,start=request.startsAt.getTime(),end=request.endsAt.getTime();
    if(end<=start||end-start>366*86400_000||(request.source.kind==='operator'&&!request.operator))deny('compute_credit_invalid');
    const digest=createHash('sha256').update(JSON.stringify([request.userId,start,end,request.amountMicroUsd,request.source,request.operator??null])).digest();
    return withSystemTx(this.pool,async tx=>{
      await lockComputeUserFunding(tx,request.userId);
      if(request.operator){
        const owner=await tx.query("SELECT 1 FROM users WHERE id=$1 AND staff_role='platform_owner' AND auth_status='active' AND deleted_at IS NULL FOR SHARE",[request.operator.actorUserId]);
        if(owner.rowCount!==1)deny('compute_credit_operator_rejected');
      }
      const recipient=await tx.query("SELECT 1 FROM users WHERE id=$1 AND auth_status='active' AND deleted_at IS NULL",[request.userId]);
      if(recipient.rowCount!==1)deny('compute_credit_scope_rejected');
      const source=request.source;
      const prior=(await tx.query<{period_id:string;request_sha256:Buffer}>(`SELECT period_id,request_sha256 FROM managed_compute_funding_receipts
        WHERE source_kind=$1 AND source_id=$2 AND line_item_id=$3`,[source.kind,source.id,source.lineItemId])).rows[0];
      if(prior){if(!timingSafeEqual(prior.request_sha256,digest))deny('compute_credit_conflict');return{periodId:prior.period_id,replayed:true};}
      const overlap=(await tx.query<Root>("SELECT * FROM managed_compute_user_periods WHERE user_id=$1 AND starts_at<$3 AND ends_at>$2 FOR UPDATE",[request.userId,request.startsAt,request.endsAt])).rows;
      let period=overlap[0];
      if(overlap.length>1||(period&&(period.starts_at.getTime()!==start||period.ends_at.getTime()!==end)))deny('compute_credit_period_overlap');
      if(period&&(await tx.query("SELECT 1 FROM managed_compute_pro_allowances WHERE period_id=$1",[period.id])).rowCount)
        deny('compute_credit_monthly_allowance_locked');
      if(!period)period=(await tx.query<Root>("INSERT INTO managed_compute_user_periods(id,user_id,starts_at,ends_at) VALUES ($1,$2,$3,$4) RETURNING *",[randomUUID(),request.userId,request.startsAt,request.endsAt])).rows[0]!;
      if(money(period.granted_micro_usd)+request.amountMicroUsd>maximum)deny('compute_credit_invalid');
      // A different user's concurrent receipt loses here. Never ON CONFLICT
      // DO NOTHING while also increasing the funding counter.
      try{await tx.query(`INSERT INTO managed_compute_funding_receipts(id,period_id,user_id,source_kind,source_id,line_item_id,request_sha256,amount_micro_usd,created_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[randomUUID(),period.id,request.userId,source.kind,source.id,source.lineItemId,digest,request.amountMicroUsd,request.operator?.actorUserId??null]);}
      catch(error){if((error as {code?:string}).code==='23505')deny('compute_credit_conflict');throw error;}
      await tx.query("UPDATE managed_compute_user_periods SET granted_micro_usd=granted_micro_usd+$2,updated_at=now() WHERE id=$1",[period.id,request.amountMicroUsd]);
      return{periodId:period.id,replayed:false};
    });
  }
  async balanceForUser(userId:string){
    if(!z.string().uuid().safeParse(userId).success)throw new HttpError(404,'compute_credit_scope_not_found','Compute balance is unavailable');
    return withSystemTx(this.pool,async tx=>{
      if(!(await tx.query("SELECT 1 FROM users WHERE id=$1 AND auth_status='active' AND deleted_at IS NULL",[userId])).rowCount)
        throw new HttpError(404,'compute_credit_scope_not_found','Compute balance is unavailable');
      const rows=(await tx.query<Root&{debited:string;reserved:string;evaluated_at:Date}>(`SELECT root.*,clock_timestamp() AS evaluated_at,
        coalesce(totals.debited,0) AS debited,coalesce(totals.reserved,0) AS reserved FROM managed_compute_user_periods root
        LEFT JOIN LATERAL (SELECT sum(debited_micro_usd) AS debited,sum(reserved_micro_usd) AS reserved
          FROM managed_compute_credit_periods WHERE funding_period_id=root.id) totals ON true
        WHERE root.user_id=$1 ORDER BY root.ends_at DESC,root.id DESC LIMIT 100`,[userId])).rows;
      return rows.map(row=>({periodId:row.id,startsAt:row.starts_at.toISOString(),endsAt:row.ends_at.toISOString(),grantedMicroUsd:money(row.granted_micro_usd),
        debitedMicroUsd:money(row.debited),reservedMicroUsd:money(row.reserved),availableMicroUsd:row.starts_at<=row.evaluated_at&&row.evaluated_at<row.ends_at?
          money(row.granted_micro_usd)-money(row.debited)-money(row.reserved):0}));
    },{consistentRead:true});
  }
}
