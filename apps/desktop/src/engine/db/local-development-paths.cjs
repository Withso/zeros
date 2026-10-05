const path = require("node:path");
const { homedir } = require("node:os");

function localInstanceStateRoot(slug, home = homedir()) {
  return path.join(home, ".zeros-local", "instances", slug);
}

function localInstanceBundlePaths({ slug, name, home = homedir() }) {
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(slug) || path.basename(name) !== name)
    throw new Error("Invalid Zeros Local bundle identity");
  const stateRoot = localInstanceStateRoot(slug, home);
  const bundlePath = path.join(stateRoot, "bundle", `${name}.app`);
  return {
    stateRoot,
    bundlePath,
    versionMarker: `${bundlePath}.version`,
    legacyBundleRoot: path.join(home, ".zeros-local", "dev-instances", slug),
  };
}

module.exports = { localInstanceStateRoot, localInstanceBundlePaths };
