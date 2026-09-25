set -euo pipefail
export PATH=/opt/zeros-runtime/bin:/usr/bin:/bin:/usr/sbin:/sbin
unset NODE_OPTIONS NODE_PATH LD_PRELOAD LD_LIBRARY_PATH GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE
cd /opt/zeros
if ! test -x /usr/lib/openssh/sftp-server; then apt-get update; apt-get install -y --no-install-recommends openssh-sftp-server; fi
CI=true pnpm install --frozen-lockfile
pnpm build:zsr-supervisor
pnpm build:engine
if ! getent group zeros-coordinator >/dev/null; then groupadd --gid 10004 zeros-coordinator; fi
if ! id zeros-coordinator >/dev/null 2>&1; then useradd --uid 10004 --gid 10004 --no-create-home --shell /usr/sbin/nologin zeros-coordinator; fi
test "$(id -u zeros-coordinator)" = 10004
test "$(id -g zeros-coordinator)" = 10004
cc -std=c11 -O2 -Wall -Wextra -Werror apps/desktop/src/engine/agents/containment/cloud-process-supervisor.c -o /opt/zeros-runtime/cloud-process-supervisor
chmod 0555 /opt/zeros-runtime/cloud-process-supervisor
pnpm rebuild better-sqlite3 node-pty
node -e 'require("better-sqlite3")();require("node-pty");console.log("native bindings verified")'
install -d -o root -g root -m 0755 /opt/zeros-runtime/lib/zeros /opt/zeros-runtime/bin
for name in runtime-layout.json cgroup-resources.mjs cloud-resource-admission.mjs image-build-contract.mjs cloud-runtime-profile.mjs cloud-engine-cgroup.mjs cloud-setup-process.mjs cloud-engine-view.mjs cloud-engine-launcher.mjs write-image-build-metadata.mjs attest-cloud-worker.mjs consume-cloud-admission.mjs install-cloud-preview-links.mjs install-cloud-github-credential.mjs cloud-github-refresh-request.mjs cloud-git-askpass.mjs cloud-worker-supervisor.mjs ensure-cloud-worker-supervisor.mjs setup-cloud-workspace.mjs; do
 install -o root -g root -m 0555 "scripts/cloud-workspace-validation/sandbox/$name" "/opt/zeros-runtime/lib/zeros/$name"
done
install -o root -g root -m 0555 scripts/cloud-workspace-validation/sandbox/start-engine.sh /opt/zeros-runtime/bin/start-engine.sh
install -o root -g root -m 0444 scripts/cloud-workspace-validation/sandbox/cloud-worker.json /etc/zeros/cloud-worker.json
install -o root -g root -m 0444 scripts/cloud-workspace-validation/sandbox/zeros-cloud-engine.apparmor /opt/zeros-runtime/lib/zeros/zeros-cloud-engine.apparmor
cc -std=c11 -O2 -Wall -Wextra -Werror scripts/cloud-workspace-validation/sandbox/cloud-engine-namespace.c -o /opt/zeros-runtime/cloud-engine-namespace
chmod 0500 /opt/zeros-runtime/cloud-engine-namespace
chown -R root:root /opt/zeros /opt/zeros-runtime
chmod -R go-w /opt/zeros /opt/zeros-runtime
rm -f /opt/zeros/.git/index
node /opt/zeros-runtime/lib/zeros/write-image-build-metadata.mjs /etc/zeros/image-build.json native-linux https://github.com/withso/zeros {{SOURCE_COMMIT}} /opt/zeros {{IMAGE_CONTRACT_SHA256}}
node -e 'const d=require("/etc/zeros/image-build.json"); console.log(JSON.stringify({version:d.version,baseImage:d.baseImage,source:d.source,artifacts:d.artifacts}))'
