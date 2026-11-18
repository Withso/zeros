// Spreads the migration suite across CI's database shards: part N of src/migrations-N.test.ts runs on shard N (mod the
// shard count). Every other file keeps vitest's own hash-ordered split. See src/migrations-part.ts.
import { BaseSequencer, type TestSpecification } from "vitest/node";

const PART = /(?:^|\/)src\/migrations-(\d+)\.test\.ts$/;

function migrationPart(spec: TestSpecification): number | undefined {
  const part = PART.exec(spec.moduleId.split("\\").join("/"))?.[1];
  return part === undefined ? undefined : Number(part);
}

export default class ControlPlaneSequencer extends BaseSequencer {
  override async shard(files: TestSpecification[]): Promise<TestSpecification[]> {
    const shard = this.ctx.config.shard;
    if (!shard) return files;
    const parts = files.filter((spec) => {
      const part = migrationPart(spec);
      return part !== undefined && (part - 1) % shard.count === shard.index - 1;
    });
    const rest = files.filter((spec) => migrationPart(spec) === undefined);
    return [...parts, ...(await super.shard(rest))];
  }
}
