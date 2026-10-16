/** Paths always belong to the selected physical runtime, including resident
 * transfers. Ambient font/Git configuration never selects an asset root. */
export const CLOUD_GIT_EXEC_ROOT = "/opt/zeros-infra/.git-exec";

export function cloudRuntimeAssetEnvironment(runtime) {
  if (runtime.profile !== "v4") return {};
  const runtimeId = runtime.runtimeId ?? runtime.workerRoot.split("/").at(-2);
  return {
    GIT_CONFIG_SYSTEM: `${runtime.workerRoot}/gitconfig`,
    GIT_EXEC_PATH: `${CLOUD_GIT_EXEC_ROOT}/${runtimeId}`,
    FONTCONFIG_FILE: `${runtime.workerRoot}/design-fonts/fonts.conf`,
    FONTCONFIG_PATH: `${runtime.workerRoot}/design-fonts`,
  };
}

export function runtimeSystemAssetFiles(value) {
  const fail = () => { throw new Error("Cloud runtime system assets are missing or invalid"); };
  const names = ["fonts-noto-color-emoji", "fonts-unifont", "xfonts-cyrillic", "xfonts-scalable",
    "fonts-ipafont-gothic", "fonts-wqy-zenhei", "fonts-tlwg-loma-otf", "fonts-freefont-ttf"];
  if (value?.schema !== "zeros.runtime-system-assets/v1" || value.gitLfs !== "bin/git-lfs" ||
      value.gitConfig !== "worker/gitconfig" || value.fontConfig !== "worker/design-fonts/fonts.conf" ||
      !Array.isArray(value.fonts) || value.fonts.length < names.length || value.fonts.length > 1024 ||
      new Set(value.fonts).size !== value.fonts.length) fail();
  for (const file of value.fonts) {
    if (typeof file !== "string" || file.length > 1024 || !/^worker\/design-fonts\/[A-Za-z0-9_+./-]+$/.test(file) ||
        file.split("/").some(part => !part || part === "." || part === "..")) fail();
  }
  if (names.some(name => !value.fonts.some(file => file.startsWith(`worker/design-fonts/${name}/`)))) fail();
  return [value.gitLfs, value.gitConfig, value.fontConfig, ...value.fonts];
}
