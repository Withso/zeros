import { createHash, randomBytes } from "node:crypto";
import {
  DevProviderError,
  dispatchDevCreate,
  providerJson,
} from "./provider-http.mjs";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const NAME = "zeros-dev-connections";
const AUDIENCE = "zeros-dev-connections-v1";
const hash = (value) => createHash("sha256").update(value).digest("hex");
function serviceOrigin(value) {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.origin !== value ||
    url.username ||
    url.password
  )
    throw new Error("Invalid Dev connections origin");
  return url.origin;
}
export function railwayConnectionsClient(config, fetchImpl = fetch) {
  if (
    config.deployment !== "dev" ||
    !UUID.test(config.projectId ?? "") ||
    config.projectId === config.disposableProjectId ||
    !config.apiToken
  )
    throw new Error("Persistent Dev Railway authority is required");
  return async (query, variables = {}, signal) => {
    const response = await providerJson(
      "Railway",
      "https://backboard.railway.com/graphql/v2",
      {
        method: "POST",
        signal,
        headers: {
          authorization: `Bearer ${config.apiToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ query, variables }),
      },
      fetchImpl,
    );
    if (
      response.status !== 200 ||
      response.body?.errors?.length ||
      !response.body?.data
    )
      throw new DevProviderError(
        "Railway",
        response.status === 200
          ? "GraphQL rejected the operation"
          : response.status,
      );
    return response.body.data;
  };
}

/** Operator-only bootstrap. Use a separate Railway PROJECT whose API token and
 * variables are unavailable to disposable profiles. No deployment is triggered.
 * lease is the persistent encrypted registry lease, never a generation receipt.
 * request is the authenticated Railway GraphQL port (same signature as railway.mjs).
 * A lost create acknowledgement is retained and never blindly dispatched again. */
export async function ensurePersistentDevConnections(
  lease,
  config,
  request = railwayConnectionsClient(config),
) {
  if (
    config.deployment !== "dev" ||
    !UUID.test(config.projectId ?? "") ||
    !UUID.test(config.disposableProjectId ?? "") ||
    config.projectId === config.disposableProjectId ||
    lease.state.kind !== "persistent-dev-connections"
  )
    throw new Error(
      "Persistent Dev connections requires its own project and registry lease",
    );
  const vars = config.serviceVariables,
    dbVars = config.databaseVariables;
  if (
    vars?.ZEROS_DEPLOY_ENV !== "dev" ||
    vars?.ZEROS_DEV_CONNECTIONS_ENABLED !== "true" ||
    !vars?.DEV_CONNECTIONS_DATABASE_URL ||
    !vars?.DEV_CONNECTIONS_ENCRYPTION_KEYS ||
    !vars?.DEV_CONNECTIONS_FINGERPRINT_KEYS ||
    !dbVars?.POSTGRES_PASSWORD ||
    dbVars?.POSTGRES_DB !== "dev_connections" ||
    !/^postgres:18(?:\.[0-9]+)?-alpine@sha256:[a-f0-9]{64}$/.test(
      config.postgresImage ?? "",
    )
  )
    throw new Error(
      "Persistent Dev service-only variables and pinned PostgreSQL image are required",
    );
  const state = lease.state;
  if (state.projectId && state.projectId !== config.projectId)
    throw new Error("Persistent Dev project changed");
  state.projectId = config.projectId;
  state.protected = true;
  state.resources ??= {};
  await lease.save();
  const inventory = async () => {
    const data = (
      await request(
        `query DevConnectionInventory($id: String!) { project(id: $id) { id
      environments(first: 100) { edges { node { id name createdAt } } pageInfo { hasNextPage } }
      services(first: 100) { edges { node { id name createdAt } } pageInfo { hasNextPage } }
      volumes(first: 100) { edges { node { id name createdAt } } pageInfo { hasNextPage } }
    } }`,
        { id: config.projectId },
        lease.signal,
      )
    ).project;
    if (
      data?.id !== config.projectId ||
      [data.environments, data.services, data.volumes].some(
        (x) => !Array.isArray(x?.edges) || x.pageInfo?.hasNextPage !== false,
      )
    )
      throw new Error("Persistent Dev inventory is incomplete");
    if (
      data.services.edges.some(
        (e) => ![NAME, `${NAME}-postgres`].includes(e.node.name),
      ) ||
      data.environments.edges.some((e) =>
        /^(alpha|beta|main)$/i.test(e.node.name),
      )
    )
      throw new Error(
        "Persistent Dev bootstrap requires an isolated project without product services",
      );
    return {
      environment: data.environments.edges.map((e) => e.node),
      service: data.services.edges.map((e) => e.node),
      volume: data.volumes.edges.map((e) => e.node),
    };
  };
  const ensure = async (key, kind, name, create) => {
    let receipt = state.resources[key];
    const list = (await inventory())[kind];
    if (receipt?.id) {
      const row = list.find((r) => r.id === receipt.id);
      if (!row || (kind !== "volume" && row.name !== name))
        throw new Error(
          "Persistent Dev resource disappeared; do not recreate its database automatically",
        );
      return receipt.id;
    }
    const matches =
      kind === "volume" ? [] : list.filter((r) => r.name === name);
    if (!receipt) {
      if (matches.length)
        throw new Error("Persistent Dev resource has no ownership receipt");
      receipt = state.resources[key] = {
        name,
        requestedAt: new Date().toISOString(),
        protected: true,
      };
      await lease.save();
    }
    if (
      matches.length === 1 &&
      receipt.create &&
      ["dispatching", "uncertain", "acknowledged"].includes(
        receipt.create.phase,
      ) &&
      Date.parse(matches[0].createdAt) >= Date.parse(receipt.requestedAt) - 5000
    ) {
      receipt.id = matches[0].id;
      receipt.create.phase = "acknowledged";
      await lease.save();
      return receipt.id;
    }
    if (matches.length) throw new Error("Ambiguous persistent Dev ownership");
    const created = await dispatchDevCreate(lease, receipt, "Railway", create);
    if (
      !UUID.test(created?.id ?? "") ||
      (kind !== "volume" && created.name !== name)
    )
      throw new Error("Persistent Dev create response is unconfirmed");
    receipt.id = created.id;
    await lease.save();
    return receipt.id;
  };
  const environmentId = await ensure(
    "environment",
    "environment",
    NAME,
    async () =>
      (
        await request(
          `mutation DevConnectionEnvironment($input: EnvironmentCreateInput!) { environmentCreate(input: $input) { id name } }`,
          {
            input: {
              projectId: config.projectId,
              name: NAME,
              ephemeral: false,
              skipInitialDeploys: true,
            },
          },
          lease.signal,
        )
      ).environmentCreate,
  );
  const serviceId = await ensure(
    "service",
    "service",
    NAME,
    async () =>
      (
        await request(
          `mutation DevConnectionService($input: ServiceCreateInput!) { serviceCreate(input: $input) { id name } }`,
          { input: { projectId: config.projectId, name: NAME } },
          lease.signal,
        )
      ).serviceCreate,
  );
  const databaseId = await ensure(
    "database",
    "service",
    `${NAME}-postgres`,
    async () =>
      (
        await request(
          `mutation DevConnectionDatabase($input: ServiceCreateInput!) { serviceCreate(input: $input) { id name } }`,
          { input: { projectId: config.projectId, name: `${NAME}-postgres` } },
          lease.signal,
        )
      ).serviceCreate,
  );
  if (!state.resources.volume?.id) {
    await lease.fence();
    await request(
      `mutation PrepareDevConnectionInstances($environmentId: String!, $patch: EnvironmentConfig!) {
      environmentPatchCommit(environmentId: $environmentId, patch: $patch, skipDeploys: true)
    }`,
      {
        environmentId,
        patch: {
          services: {
            [serviceId]: {
              isCreated: true,
              source: { repo: null, image: null },
            },
            [databaseId]: {
              isCreated: true,
              source: { repo: null, image: null },
            },
          },
        },
      },
      lease.signal,
    );
  }
  const volumeId = await ensure(
    "volume",
    "volume",
    `${NAME}-postgres-data`,
    async () =>
      (
        await request(
          `mutation DevConnectionVolume($input: VolumeCreateInput!) { volumeCreate(input: $input) { id name } }`,
          {
            input: {
              projectId: config.projectId,
              environmentId,
              serviceId: databaseId,
              mountPath: "/var/lib/postgresql",
            },
          },
          lease.signal,
        )
      ).volumeCreate,
  );
  // PostgreSQL 18 uses a versioned PGDATA beneath /var/lib/postgresql.
  const configurationHash = hash(
    JSON.stringify([vars, dbVars, config.postgresImage]),
  );
  if (state.configurationHash && state.configurationHash !== configurationHash)
    throw new Error(
      "Use an explicit service-key/database rotation; bootstrap cannot replace persistent secrets",
    );
  state.configurationHash = configurationHash;
  if (state.configured)
    return {
      projectId: config.projectId,
      environmentId,
      serviceId,
      databaseId,
      volumeId,
      protected: true,
    };
  await lease.save();
  await lease.fence();
  await request(
    `mutation DevConnectionInstances($environmentId: String!, $patch: EnvironmentConfig!) { environmentPatchCommit(environmentId: $environmentId, patch: $patch, skipDeploys: true) }`,
    {
      environmentId,
      patch: {
        services: {
          [serviceId]: {
            isCreated: true,
            source: { repo: null, image: null },
            build: {
              builder: "DOCKERFILE",
              dockerfilePath: "src/dev-connections/Dockerfile",
            },
            deploy: {
              startCommand: "node dist/dev-connections/index.js",
              healthcheckPath: "/healthz",
              numReplicas: 1,
              sleepApplication: false,
            },
          },
          [databaseId]: {
            isCreated: true,
            source: { repo: null, image: config.postgresImage },
            deploy: { numReplicas: 1, sleepApplication: false },
          },
        },
      },
    },
    lease.signal,
  );
  for (const [id, variables] of [
    [serviceId, vars],
    [databaseId, dbVars],
  ]) {
    await lease.fence();
    await request(
      `mutation DevConnectionVariables($input: VariableCollectionUpsertInput!) { variableCollectionUpsert(input: $input) }`,
      {
        input: {
          projectId: config.projectId,
          environmentId,
          serviceId: id,
          variables,
          replace: true,
          skipDeploys: true,
        },
      },
      lease.signal,
    );
    await lease.fence();
    await request(
      `mutation DevConnectionLimits($input: ServiceInstanceLimitsUpdateInput!) { serviceInstanceLimitsUpdate(input: $input) }`,
      { input: { environmentId, serviceId: id, vCPUs: 1, memoryGB: 1 } },
      lease.signal,
    );
  }
  state.configured = true;
  await lease.save();
  return {
    projectId: config.projectId,
    environmentId,
    serviceId,
    databaseId,
    volumeId,
    protected: true,
  };
}

/** Phase 2 must union this into EVERY archive/GC protected set. The entire
 * separate project is protected, including a create whose ID is not known yet. */
export function connectionProtection(receipt) {
  if (!UUID.test(receipt?.projectId ?? ""))
    throw new Error("Persistent Dev protection receipt required");
  return {
    projectIds: [receipt.projectId],
    environmentIds: [receipt.environmentId].filter(Boolean),
    serviceIds: [receipt.serviceId, receipt.databaseId].filter(Boolean),
    volumeIds: [receipt.volumeId].filter(Boolean),
    names: [NAME, `${NAME}-postgres`],
  };
}
export function assertDisposableConnectionTarget(target, protection) {
  if (
    !protection ||
    protection.projectIds.includes(target.projectId) ||
    protection.environmentIds.includes(target.id) ||
    protection.serviceIds.includes(target.id) ||
    protection.volumeIds.includes(target.id) ||
    protection.names.includes(target.name)
  )
    throw new Error(
      "Persistent Dev connections is protected from archive and GC",
    );
}
async function brokerRequest(config, path, method, body, fetchImpl) {
  const origin = serviceOrigin(config.origin);
  const response = await providerJson(
    "Dev connections",
    `${origin}${path}`,
    {
      method,
      headers: {
        authorization: `Bearer ${config.registrationToken}`,
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    fetchImpl,
  );
  if (response.status !== 200)
    throw new Error("Dev connection generation operation is unconfirmed");
  return response.body;
}
/** Generation credential is written into the encrypted lease BEFORE registration,
 * so lost acknowledgements replay the identical operation. No member material. */
export async function registerConnectionGeneration(
  lease,
  config,
  fetchImpl = fetch,
) {
  if (
    config.deployment !== "dev" ||
    lease.state.status === "archiving" ||
    lease.state.status === "archived" ||
    !UUID.test(lease.state.generation ?? "") ||
    !/^[a-f0-9]{24}$/.test(lease.state.owner ?? "")
  )
    throw new Error("Invalid Dev connection generation");
  serviceOrigin(config.origin);
  if (
    lease.state.connectionServiceOrigin &&
    lease.state.connectionServiceOrigin !== config.origin
  )
    throw new Error("Dev connection service origin changed");
  lease.state.connectionServiceOrigin = config.origin;
  let registration = lease.state.connectionRegistration;
  if (!registration) {
    registration = lease.state.connectionRegistration = {
      id: lease.state.generation,
      owner: lease.state.owner,
      organization: config.organization,
      audience: AUDIENCE,
      credential: randomBytes(32).toString("base64url"),
      keyRevision: 1,
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
      source: "hosted-dev",
    };
    await lease.save();
  }
  if (
    registration.id !== lease.state.generation ||
    registration.owner !== lease.state.owner ||
    registration.organization !== config.organization
  )
    throw new Error("Dev connection generation changed");
  await lease.fence();
  await brokerRequest(
    config,
    "/v1/generations",
    "POST",
    registration,
    fetchImpl,
  );
  lease.state.connectionRegistered = true;
  await lease.save();
  return {
    DEV_CONNECTIONS_ORIGIN: config.origin,
    DEV_CONNECTIONS_GENERATION: registration.id,
    DEV_CONNECTIONS_GENERATION_CREDENTIAL: registration.credential,
    DEV_CONNECTIONS_AUDIENCE: AUDIENCE,
  };
}
/** Keep this task in the remote registry even when the checkout is gone. A false
 * result means pending revocation, NOT an archive-complete receipt. Stop compute
 * independently and let GC retry. Registration expiry bounds an outage. */
export async function revokeConnectionGeneration(
  lease,
  config,
  fetchImpl = fetch,
) {
  if (config.deployment !== "dev" || !UUID.test(lease.state.generation ?? ""))
    throw new Error("Invalid Dev connection generation");
  if (
    (lease.state.connectionServiceOrigin &&
      lease.state.connectionServiceOrigin !== config.origin) ||
    (lease.state.connectionRegistration &&
      lease.state.connectionRegistration.id !== lease.state.generation)
  )
    throw new Error("Dev connection revocation target changed");
  serviceOrigin(config.origin);
  lease.state.connectionServiceOrigin ??= config.origin;
  lease.state.connectionRevocation = {
    generation: lease.state.generation,
    origin: config.origin,
    pending: true,
  };
  await lease.save();
  await lease.fence();
  try {
    await brokerRequest(
      config,
      `/v1/generations/${lease.state.generation}`,
      "DELETE",
      undefined,
      fetchImpl,
    );
  } catch {
    return { revoked: false, pending: true };
  }
  lease.state.connectionRevocation.pending = false;
  lease.state.connectionRevocation.revokedAt = new Date().toISOString();
  delete lease.state.connectionRegistration;
  await lease.save();
  return { revoked: true, pending: false };
}

/** Persist the next leaf before PUT; retries never rotate twice after a lost reply. */
export async function rotateConnectionGeneration(lease, config, fetchImpl = fetch, now = Date.now()) {
  if (!lease.state.connectionRegistered) return registerConnectionGeneration(lease, config, fetchImpl);
  if (config.deployment !== "dev" || lease.state.connectionServiceOrigin !== serviceOrigin(config.origin) ||
      ["archiving", "archived"].includes(lease.state.status)) throw new Error("Invalid Dev rotation target");
  const current = lease.state.connectionRegistration;
  if (!current || current.id !== lease.state.generation || current.owner !== lease.state.owner || current.organization !== config.organization)
    throw new Error("Invalid Dev rotation owner");
  if (Date.parse(current.expiresAt) <= now + 6 * 3600000 || lease.state.connectionRotation) {
    lease.state.connectionRotation ??= {...current, credential:randomBytes(32).toString("base64url"), keyRevision:current.keyRevision+1,
      expiresAt:new Date(now+86400000).toISOString()};
    await lease.save(); await lease.fence();
    await brokerRequest(config, `/v1/generations/${current.id}/key`, "PUT", lease.state.connectionRotation, fetchImpl);
    lease.state.connectionRegistration = lease.state.connectionRotation;
    delete lease.state.connectionRotation;
    await lease.save();
  }
  const registration = lease.state.connectionRegistration;
  return {DEV_CONNECTIONS_ORIGIN:config.origin, DEV_CONNECTIONS_GENERATION:registration.id,
    DEV_CONNECTIONS_GENERATION_CREDENTIAL:registration.credential, DEV_CONNECTIONS_AUDIENCE:AUDIENCE};
}

/** Operator registry is a separate bucket/key, unavailable to portable profiles.
 * Reuse W4's CAS heartbeat and mutation fence, in a distinct document namespace. */
export async function withPersistentConnectionLease(store, projectId, operation, signal) {
  const { withHostedLease } = await import("./hosted-state.mjs");
  if(!UUID.test(projectId))throw new Error("Invalid persistent project");
  const owner=hash(`persistent-dev-connections:${projectId}`).slice(0,24), key=`connections/v1/${projectId}.json`;
  return withHostedLease({
    read:()=>store.readDocument(key,owner,value=>{
      if(value.kind!=="persistent-dev-connections" || value.projectId!==projectId)throw new Error("Persistent connection receipt mismatch");
      return value;
    }),
    write:(_owner,state,etag)=>store.writeDocument(key,{...state,kind:"persistent-dev-connections",projectId},etag),
  },{owner,identity:`persistent-dev-connections:${projectId}`},async lease=>{
    lease.state.kind="persistent-dev-connections";lease.state.projectId=projectId;
    return operation(lease);
  },{create:true,signal});
}

export async function deployPersistentDevConnections(lease,config,artifact,request=railwayConnectionsClient(config),fetchImpl=fetch) {
  const { default:fs }=await import("node:fs");
  const { pollProvider }=await import("./provider-http.mjs");
  const state=lease.state;
  state.secrets ??= { database:randomBytes(32).toString('base64url'),owner:randomBytes(32).toString('base64url'),runtime:randomBytes(32).toString('base64url'),
    provisioner:randomBytes(32).toString('base64url'),encryption:randomBytes(32).toString('base64url'),fingerprint:randomBytes(32).toString('base64url') };
  await lease.save();
  const secret=state.secrets, host='${{zeros-dev-connections-postgres.RAILWAY_PRIVATE_DOMAIN}}';
  const dbUrl=(user,password)=>`postgresql://${user}:${password}@${host}:5432/dev_connections`;
  const vars={...config.serviceVariables,ZEROS_DEPLOY_ENV:'dev',ZEROS_DEV_CONNECTIONS_ENABLED:'true',
    DEV_CONNECTIONS_ORIGIN:'https://bootstrap.invalid',DEV_CONNECTIONS_DATABASE_URL:dbUrl('zeros_connections_runtime',secret.runtime),
    DEV_CONNECTIONS_PROVISIONER_TOKEN:secret.provisioner,
    DEV_CONNECTIONS_ENCRYPTION_KEYS:JSON.stringify({currentKeyVersion:1,keys:{1:secret.encryption}}),
    DEV_CONNECTIONS_FINGERPRINT_KEYS:JSON.stringify({currentKeyVersion:1,keys:{1:secret.fingerprint}})};
  const resources=await ensurePersistentDevConnections(lease,{...config,serviceVariables:vars,
    databaseVariables:{POSTGRES_USER:'postgres',POSTGRES_PASSWORD:secret.database,POSTGRES_DB:'dev_connections'}},request);
  const target={environmentId:resources.environmentId,serviceId:resources.serviceId};
  const deployment=async(id,serviceId)=>{
    const value=(await request('query ConnectionDeployment($id: String!) { deployment(id:$id) { id projectId environmentId serviceId status } }',{id},lease.signal)).deployment;
    if(value?.projectId!==config.projectId||value.environmentId!==resources.environmentId||value.serviceId!==serviceId)throw new Error('Persistent deployment ownership mismatch');
    if(['FAILED','CRASHED','REMOVED','SKIPPED'].includes(value.status))throw new Error('Persistent deployment failed; retain and reconcile its receipt');
    return value.status==='SUCCESS';
  };
  const wait=id=>pollProvider('Dev connection deployment',()=>deployment(id,resources.serviceId),{signal:lease.signal,timeout:600000});
  const database=state.resources.database;
  if(!database.deploymentId){
    await dispatchDevCreate(lease,database,'Railway',async()=>{
      const result=await request('mutation DeployConnectionDatabase($serviceId:String!,$environmentId:String!){serviceInstanceDeployV2(serviceId:$serviceId,environmentId:$environmentId)}',
        {...target,serviceId:resources.databaseId},lease.signal);
      if(!UUID.test(result.serviceInstanceDeployV2??''))throw new Error('Persistent database deployment unconfirmed');
      database.deploymentId=result.serviceInstanceDeployV2;await lease.save();return result;
    },{key:'deploymentCreate'});
  }
  await pollProvider('Persistent Dev database',()=>deployment(database.deploymentId,resources.databaseId),{signal:lease.signal,timeout:600000});
  if(!state.origin){
    const domains=(await request('query ConnectionDomains($projectId:String!,$environmentId:String!,$serviceId:String!){domains(projectId:$projectId,environmentId:$environmentId,serviceId:$serviceId){serviceDomains{id domain}}}',
      {projectId:config.projectId,...target},lease.signal)).domains?.serviceDomains;
    if(!Array.isArray(domains))throw new Error('Persistent domain inventory unavailable');
    if(domains.length){
      if(domains.length!==1||!state.domainCreate)throw new Error('Unowned persistent domain');
      state.origin=serviceOrigin(`https://${domains[0].domain}`);await lease.save();
    }else await dispatchDevCreate(lease,state,'Railway',async()=>{
      const value=(await request('mutation ConnectionDomain($input:ServiceDomainCreateInput!){serviceDomainCreate(input:$input){id domain}}',
        {input:{...target,targetPort:8080}},lease.signal)).serviceDomainCreate;
      state.origin=serviceOrigin(`https://${value?.domain}`);await lease.save();return value;
    },{key:'domainCreate'});
  }
  const body=fs.readFileSync(artifact.archive);
  if(body.length>32*1024*1024||hash(body)!==artifact.archiveSha256)throw new Error('Invalid persistent broker source artifact');
  const digest=artifact.inputSha256??artifact.digest;
  // The bootstrap process has no provider routes or renewers. Owner/admin
  // variables are removed before the ordinary runtime deployment is started.
  const publish=async(phase,variables,startCommand)=>{
    const slot=`${phase}Deployment`;let receipt=state[slot];
    if(receipt&&receipt.digest!==digest){
      if(!receipt.deploymentId)throw new Error('Uncertain persistent deployment requires reconciliation');
      receipt=undefined;
    }
    if(!receipt){receipt=state[slot]={digest};await lease.save();}
    if(!receipt.deploymentId){
      await lease.fence();
      await request('mutation ConnectionRuntimeConfig($environmentId:String!,$patch:EnvironmentConfig!){environmentPatchCommit(environmentId:$environmentId,patch:$patch,skipDeploys:true)}',
        {environmentId:target.environmentId,patch:{services:{[target.serviceId]:{deploy:{startCommand,healthcheckPath:'/healthz',numReplicas:1,overlapSeconds:0}}}}},lease.signal);
      await request('mutation ConnectionRuntimeVariables($input:VariableCollectionUpsertInput!){variableCollectionUpsert(input:$input)}',
        {input:{projectId:config.projectId,...target,variables:{...vars,...variables,DEV_CONNECTIONS_ORIGIN:state.origin,DEV_CONNECTIONS_BUILD:digest},replace:true,skipDeploys:true}},lease.signal);
      await dispatchDevCreate(lease,receipt,'Railway source upload',async()=>{
        const url=new URL(`https://backboard.railway.com/project/${config.projectId}/environment/${target.environmentId}/up`);
        url.searchParams.set('serviceId',target.serviceId);url.searchParams.set('message',`dev-connections:${phase}:${digest}`);
        const result=await providerJson('Railway source upload',url,{method:'POST',signal:lease.signal,body,
          headers:{authorization:`Bearer ${config.apiToken}`,'content-type':'application/gzip'}},fetchImpl);
        if(result.status!==200||!UUID.test(result.body?.deploymentId??''))throw new Error('Persistent upload acknowledgement unavailable');
        receipt.deploymentId=result.body.deploymentId;await lease.save();return result.body;
      });
    }
    await wait(receipt.deploymentId);
  };
  if(state.deployedDigest!==digest){
    // Runtime's durable intent is written only after bootstrap succeeded. Older
    // receipts may lack the explicit progress marker; never revisit a bootstrap
    // Railway has removed after its healthy runtime replacement became active.
    if(state.runtimeDeployment?.digest!==digest && state.bootstrapCompletedDigest!==digest){
      await publish('bootstrap',{DEV_CONNECTIONS_ADMIN_DATABASE_URL:dbUrl('postgres',secret.database),
        DEV_CONNECTIONS_MIGRATION_DATABASE_URL:dbUrl('zeros_connections_owner',secret.owner)},'node dist/dev-connections/index.js --bootstrap');
      state.bootstrapCompletedDigest=digest;await lease.save();
    }
    await publish('runtime',{},'node dist/dev-connections/index.js');
  }
  await pollProvider('Persistent Dev readiness',async()=>{
    const response=await providerJson('Dev connections',`${state.origin}/healthz`,{signal:lease.signal},fetchImpl);
    return response.status===200&&response.body?.service==='dev-connections'&&response.body?.mode==='runtime'&&response.body?.build===digest;
  },{signal:lease.signal,timeout:120000});
  state.deployedDigest=digest;await lease.save();
  return {...resources,origin:state.origin,registrationToken:secret.provisioner,organization:vars.DEV_CONNECTIONS_WORKOS_ORGANIZATION_ID,deployment:'dev'};
}

/** Loaded only for explicitly opted-in hosted Dev. No operator authority is
 * copied to generation receipts, provider variables, renderer or portable JSON. */
export function persistentConnectionLifecycle(profile,{operator,registry,source,fetchImpl=fetch,request}={}) {
  if(!profile.connections?.enabled)return [];
  if(profile.connections.cutover!=='connect-once'||operator?.projectId!==profile.connections.projectId||operator.projectId===profile.railway.projectId||
    operator.registry.bucket===profile.registry.bucket)throw new Error('Separate persistent Dev operator authority is required');
  const config={...operator,deployment:'dev',disposableProjectId:profile.railway.projectId};
  return [{name:'connections',
    async beforeDeploy(lease){
      const configResult=await withPersistentConnectionLease(registry,operator.projectId,
        persistent=>deployPersistentDevConnections(persistent,config,source().backend,request,fetchImpl),lease.signal);
      lease.state.connectionProtection=connectionProtection(configResult);await lease.save();
      lease.state.connectionBackendEnvironment=await rotateConnectionGeneration(lease,configResult,fetchImpl);await lease.save();
    },
    async archive(lease){
      if(!lease.state.connectionServiceOrigin&&!lease.state.connectionRegistration)return;
      await withPersistentConnectionLease(registry,operator.projectId,async persistent=>{
        if(!persistent.state.origin||!persistent.state.secrets?.provisioner)throw new Error('Persistent revocation authority unavailable');
        const result=await revokeConnectionGeneration(lease,{deployment:'dev',origin:persistent.state.origin,registrationToken:persistent.state.secrets.provisioner},fetchImpl);
        if(!result.revoked)throw new Error('Dev connection revocation pending; GC must retry');
        delete lease.state.connectionBackendEnvironment;await lease.save();
      },lease.signal);
    },
  }];
}
