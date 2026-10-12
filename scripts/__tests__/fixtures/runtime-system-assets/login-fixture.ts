import { existsSync } from "node:fs";
import { chmod, copyFile, mkdir, readdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { stageExtractedSystemAssets, type RuntimeAssetPackage } from "../../../cloud-workspace-validation/runtime-bundle/system-assets";
import { sha256 } from "../../../cloud-workspace-validation/runtime-bundle/manifest";
import { testCloudRuntime } from "../../../../apps/desktop/src/engine/agents/__tests__/helpers/test-cloud-runtime";

export const lfsLoginRuntime = process.env.ZEROS_RUNTIME_SYSTEM_ASSETS_TEST_DIR;
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

/** Only synthetic homes/repos/profiles are visible to the real login shell.
 * The pinned executable was acquired separately; these tests never download. */
export async function runtimeLfsLoginFixture(root: string, legacyResident = false) {
  const runtime = testCloudRuntime(), infra = path.join(root, "infra"), staged = path.join(infra, runtime.runtimeId), extracted = new Map<string, string>();
  const packages: RuntimeAssetPackage[] = [];
  for (const name of ["git-lfs", "fonts-noto-color-emoji", "fonts-unifont", "xfonts-cyrillic", "xfonts-scalable",
    "fonts-ipafont-gothic", "fonts-wqy-zenhei", "fonts-tlwg-loma-otf", "fonts-freefont-ttf"]) {
    const directory = path.join(root, "extracted", name), copyright = `synthetic ${name} terms`;
    await mkdir(path.join(directory, "usr/share/doc", name), { recursive: true });
    await writeFile(path.join(directory, "usr/share/doc", name, "copyright"), copyright);
    if (name === "git-lfs") {
      await mkdir(path.join(directory, "usr/bin"), { recursive: true });
      await copyFile(path.join(lfsLoginRuntime!, "bin/git-lfs"), path.join(directory, "usr/bin/git-lfs"));
      await chmod(path.join(directory, "usr/bin/git-lfs"), 0o555);
    } else {
      await mkdir(path.join(directory, "usr/share/fonts"), { recursive: true });
      await writeFile(path.join(directory, "usr/share/fonts/fixture.ttf"), "synthetic font");
    }
    extracted.set(name, directory);
    packages.push({ name, version: "1.0-1", architecture: "amd64", component: "universe", filename: `pool/${name}.deb`,
      size: 1, sha256: "a".repeat(64), license: "MIT", copyrightSha256: sha256(Buffer.from(copyright)) });
  }
  await stageExtractedSystemAssets({ runtime: staged, extracted, packages });
  for (const directory of ["home", "repository", "hostile", "infra/.git-exec", "etc"])
    await mkdir(path.join(root, directory));
  await writeFile(path.join(root, "hostile/git-lfs"), "#!/bin/sh\nprintf 'HOSTILE_LFS\\n'\n: > /fixture/hostile-ran\nexit 99\n", { mode: 0o755 });
  await writeFile(path.join(root, "etc/profile"), "export PATH=/usr/bin:/bin\n");
  await writeFile(path.join(root, "home/.bash_profile"), "export PATH=/fixture/hostile:/usr/bin:/bin\n: > /fixture/profile-ran\n");
  // Model the root-owned projection independently of the launcher. The real
  // namespace binds it read-only at exactly the production selector path.
  const stock = existsSync("/usr/lib/git-core") ? "/usr/lib/git-core" : "/usr/libexec/git-core";
  const execPath = path.join(infra, ".git-exec", runtime.runtimeId); await mkdir(execPath);
  for (const name of await readdir(stock))
    if (name !== "git-lfs") await symlink(path.join(stock, name), path.join(execPath, name));
  await symlink(`${runtime.binRoot}/git-lfs`, path.join(execPath, "git-lfs"));
  await writeFile(path.join(root, "exercise.sh"), `set -eu
test "$PATH" = /fixture/hostile:/usr/bin:/bin
export GIT_CONFIG_GLOBAL=/dev/null
selected_exec=\${GIT_EXEC_PATH-}
unset GIT_EXEC_PATH
git init -q .
printf 'process.bin filter=lfs -text\\nclean-smudge.bin filter=fixture-lfs -text\\n' > .gitattributes
git config filter.fixture-lfs.clean "$(git config --system --get filter.lfs.clean)"
git config filter.fixture-lfs.smudge "$(git config --system --get filter.lfs.smudge)"
git config filter.fixture-lfs.required true
for mode in process clean-smudge; do
  printf 'synthetic %s payload\\n' "$mode" > "$mode.bin"
  git add .gitattributes "$mode.bin"
  git show ":$mode.bin" | /usr/bin/grep -q '^version https://git-lfs.github.com/spec/v1$'
  /usr/bin/rm "$mode.bin"
  git checkout-index --force "$mode.bin"
  test "$(cat "$mode.bin")" = "synthetic $mode payload"
done
if test -n "$selected_exec"; then export GIT_EXEC_PATH=$selected_exec; fi
git lfs version
git lfs install --local
git hook run post-checkout -- 0000000000000000000000000000000000000000 0000000000000000000000000000000000000000 0
git submodule status
test ! -e /fixture/hostile-ran
printf 'P5_LFS_OK\\n'
`);
  const namespace = ["--inh-caps=-all", "--ambient-caps=-all", "bwrap", "--unshare-user", "--uid", "10003", "--gid", "10003",
    "--unshare-net", "--unshare-ipc", "--cap-drop", "ALL", "--die-with-parent", "--ro-bind", "/usr", "/usr",
    "--ro-bind", "/lib", "/lib", "--ro-bind", "/lib64", "/lib64", "--symlink", "usr/bin", "/bin", "--symlink", "usr/sbin", "/sbin",
    "--ro-bind", "/proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp", "--bind", root, "/fixture",
    ...(legacyResident ? ["--ro-bind", infra, "/opt/zeros-infra"] : ["--ro-bind", staged, runtime.root,
      "--ro-bind", path.join(infra, ".git-exec"), "/opt/zeros-infra/.git-exec"]),
    "--ro-bind", path.join(root, "etc/profile"), "/etc/profile", "--bind", path.join(root, "repository"), "/srv/zeros/workspace",
    "--bind", path.join(root, "home"), "/srv/zeros/home/agent", "--chdir", "/srv/zeros/workspace", "--"];
  const wrapper = path.join(root, "login-bash");
  await writeFile(wrapper, `#!/bin/sh\nexec /usr/bin/setpriv ${namespace.map(quote).join(" ")} /bin/bash "$@"\n`, { mode: 0o755 });
  return { runtime, staged, wrapper, namespace, command: ". /fixture/exercise.sh" };
}
