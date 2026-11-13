import { SHARD_COUNT, selectScenarios } from "./scenarios.mjs";

export function parseSmokeArgs(args) {
  const options = { list: false, format: "text", shard: undefined, scenarios: undefined };
  const seen = new Set();
  for (const arg of args) {
    const flag = arg.split("=")[0];
    if (!["--list", "--shard", "--format", "--scenario"].includes(flag)) {
      throw new Error(`unknown argument: ${arg}`);
    }
    if (flag === "--scenario") {
      const id = /^--scenario=(.+)$/.exec(arg)?.[1];
      if (!id)
        throw new Error("expected --scenario=<id>, for example --scenario=design-pages");
      options.scenarios = [...new Set([...(options.scenarios ?? []), id])];
      continue;
    }
    if (seen.has(flag)) throw new Error(`duplicate argument: ${flag}`);
    seen.add(flag);
    if (arg === "--list") {
      options.list = true;
    } else if (flag === "--shard") {
      const match = /^--shard=(\d+)\/(\d+)$/.exec(arg);
      if (!match)
        throw new Error("expected --shard=k/n, for example --shard=1/3");
      const [, index, count] = match.map(Number);
      if (count !== SHARD_COUNT)
        throw new Error(`shard count must be ${SHARD_COUNT}`);
      if (index < 1 || index > count)
        throw new Error(`shard index must be between 1 and ${count}`);
      options.shard = index;
    } else if (arg === "--format=json") {
      options.format = "json";
    } else {
      throw new Error(
        `invalid argument: ${arg}; use --list, --shard=k/n, --scenario=<id> or --format=json`,
      );
    }
  }
  if (seen.has("--format") && !options.list)
    throw new Error("--format=json requires --list");
  if (options.scenarios) selectScenarios(options.shard, options.scenarios);
  return options;
}
