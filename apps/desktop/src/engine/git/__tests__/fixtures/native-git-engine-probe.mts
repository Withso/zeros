import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { createNativeGithubBroker } from "../../github-native-broker";
const exec = promisify(execFile), root = process.argv[2]!;
const repo = path.join(root, "repo");
await exec("/usr/bin/git", ["init", "--initial-branch=topic", repo]);
let branch: string | null | undefined;
const broker = await createNativeGithubBroker({ directory: path.join(root, "broker"), visibleDirectory: path.join(root, "broker"),
  cwd: repo, path: "/usr/bin:/bin", node: process.execPath, identity: { uid: process.geteuid!(), gid: process.getegid!() },
  source: { kind: "agent", leaseId: "11111111-1111-4111-8111-111111111111" }, authorized: () => true,
  request: async request => { branch = request.branch; return { token: `zgp_${"p".repeat(43)}`, owner: "org", repository: "repo", expiresAtMs: Date.now() + 60000, release: async () => {} }; },
  forward: async () => new Response("0000", { headers: { "content-type": "application/x-git-upload-pack-advertisement" } }),
});
try {
  await exec(path.join(root, "broker/git"), ["ls-remote", "https://github.com/org/repo.git"], {
    cwd: repo, env: broker.env, timeout: 10000,
  }).catch(() => undefined);
  process.stdout.write(JSON.stringify({ engineUid: process.geteuid?.(), branch }));
} finally { await broker.stopAndProve(); }
