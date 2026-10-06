import { SHARD_COUNT } from "./scenarios.mjs";

export function parseSmokeArgs(args) {
  const options = { list: false, format: "text", shard: undefined };
  const seen = new Set();
  for (const arg of args) {
    const flag = arg.split("=")[0];
    if (!["--list", "--shard", "--format"].includes(flag)) {
      throw new Error(`unknown argument: ${arg}`);
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
        `invalid argument: ${arg}; use --list, --shard=k/n or --format=json`,
      );
    }
  }
  if (seen.has("--format") && !options.list)
    throw new Error("--format=json requires --list");
  return options;
}
