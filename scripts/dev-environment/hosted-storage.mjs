import { createRequire } from "node:module";
import { sha256 } from "./state.mjs";

export function devObjectStorage(config, dependencies) {
  const require = createRequire(new URL("../../apps/control-plane/package.json", import.meta.url));
  const sdk = dependencies?.sdk ?? require("@aws-sdk/client-s3");
  const client = dependencies?.client ?? new sdk.S3Client({ region: "auto", endpoint: config.endpoint,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey }, maxAttempts: 2 });
  // Archives can be tens of MiB on a developer's uplink. Keep metadata calls
  // short while giving bounded artifact transfers their own deadline.
  const transferTimeout = 180_000;
  const send = (command, { timeout = 20_000, signal } = {}) => client.send(command, {
    abortSignal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout),
  });
  const prefix = state => {
    if (!/^[a-f0-9]{24}$/.test(state.owner ?? "") || !/^[a-f0-9-]{36}$/.test(state.generation ?? "")) throw new Error("Invalid Dev storage owner");
    return `dev/${state.owner}/${state.generation}/`;
  };
  const read = async (Key, maximum) => {
    const result = await send(new sdk.GetObjectCommand({ Bucket: config.bucket, Key }), { timeout: transferTimeout });
    if (result.ContentLength > maximum) throw new Error();
    const chunks = []; let size = 0;
    for await (const chunk of result.Body) { size += chunk.length; if (size > maximum) { result.Body.destroy?.(); throw new Error(); } chunks.push(chunk); }
    return Buffer.concat(chunks);
  };
  return {
    async saveImageSource(lease, record, body) {
      if (body.length > 32 * 1024 * 1024 || !/^[a-f0-9]{64}$/.test(record.inputsSha256)) throw new Error("Invalid Dev worker archive");
      const digest = sha256(body), Key = `${prefix(lease.state)}_images/${record.inputsSha256}/${digest}.tar.gz`;
      await lease.fence();
      try { await send(new sdk.PutObjectCommand({ Bucket: config.bucket, Key, Body: body, ContentType: "application/gzip" }),
        { timeout: transferTimeout, signal: lease.signal }); }
      catch { throw new Error("Could not preserve the Dev worker source; no install was dispatched"); }
      record.sourceArchive = { key: Key, digest }; await lease.save();
    },
    async readImageSource(state, record) {
      const saved = record.sourceArchive;
      if (!saved || !/^[a-f0-9]{64}$/.test(saved.digest) || saved.key !== `${prefix(state)}_images/${record.inputsSha256}/${saved.digest}.tar.gz`) throw new Error("Invalid Dev worker source receipt");
      let body;
      try { body = await read(saved.key, 32 * 1024 * 1024); }
      catch { throw new Error("Could not retrieve the original Dev worker source archive; retain its receipt"); }
      if (sha256(body) !== saved.digest) throw new Error("Dev worker source archive checksum changed");
      return body;
    },
    async verify(state) {
      try { await send(new sdk.ListObjectsV2Command({ Bucket: config.bucket, Prefix: prefix(state), MaxKeys: 1 })); }
      catch { throw new Error("Dev object storage is unavailable; check the dedicated bucket and scoped S3 credentials"); }
    },
    async saveOperator(lease, artifact) {
      const Key = `${prefix(lease.state)}_operator/${artifact.digest}.gz`;
      await lease.fence();
      try { await send(new sdk.PutObjectCommand({ Bucket: config.bucket, Key, Body: artifact.body, ContentType: "application/gzip" }),
        { timeout: transferTimeout, signal: lease.signal }); }
      catch { throw new Error("Could not preserve the Dev cleanup artifact; deployment stopped"); }
      lease.state.resources.operator = { key: Key, digest: artifact.digest }; await lease.save();
    },
    async readOperator(state) {
      const saved = state.resources.operator;
      if (!saved || saved.key !== `${prefix(state)}_operator/${saved.digest}.gz` || !/^[a-f0-9]{64}$/.test(saved.digest)) throw new Error("Missing Dev cleanup artifact receipt");
      try {
        return await read(saved.key, 8 * 1024 * 1024);
      } catch { throw new Error("Could not retrieve the Dev cleanup artifact; its database and ownership receipts were preserved"); }
    },
    async clear(lease) {
      if (lease.state.status !== "archiving" || !lease.state.steps.workersDeleted || !lease.state.steps.railwayDeleted) throw new Error("Stop all writers before deleting Dev objects");
      const Prefix = prefix(lease.state);
      // Always restart at the first page after deletion. Continuation tokens
      // can skip keys when the underlying listing changes during cleanup.
      for (let page = 0; page < 10000; page++) {
        await lease.fence();
        let result;
        try { result = await send(new sdk.ListObjectsV2Command({ Bucket: config.bucket, Prefix, MaxKeys: 1000 })); }
        catch { throw new Error("Dev object inventory failed; archive is incomplete"); }
        const keys = (result.Contents ?? []).map(entry => entry.Key);
        if (keys.some(key => typeof key !== "string" || !key.startsWith(Prefix))) throw new Error("Dev storage returned an object outside the owned prefix");
        if (!keys.length) { if (result.IsTruncated) throw new Error("Dev storage inventory was truncated"); return; }
        await lease.fence();
        try {
          const response = await send(new sdk.DeleteObjectsCommand({ Bucket: config.bucket, Delete: { Quiet: true, Objects: keys.map(Key => ({ Key })) } }));
          if (response.Errors?.length) throw new Error();
        } catch { throw new Error("Dev object deletion was not confirmed; retry archive"); }
      }
      throw new Error("Dev object cleanup exceeded its bounded batch budget; retry archive");
    },
    close() { client.destroy(); },
  };
}
