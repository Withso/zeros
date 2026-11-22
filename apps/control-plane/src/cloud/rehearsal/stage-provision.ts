// Stage provision, check-only: the fixture repositories the other stages need must already exist, as the GitHub identity
// the run uses sees them. The rehearsal never creates or deletes a repository: the Alpha App has no administration
// permission, and the owner creates fixtures himself. Only Withso/zeros-dev-fixture* names (guard.ts).
import { RehearsalFailure, type StageContext } from "./contract.js";
import { assertRepository } from "./guard.js";

/** R2's default name, as the owner created it (public). */
export const FIXTURE_TWO = "Withso/zeros-dev-fixture-2";

export async function stageProvision(ctx: StageContext): Promise<Record<string, number>> {
  ctx.repositories.two ??= FIXTURE_TWO;
  const wanted = [ctx.repositories.one, ctx.repositories.two, ctx.repositories.submodules, ctx.repositories.submoduleFixture]
    .filter((name): name is string => !!name).map(assertRepository);
  let present = 0;
  for (const repository of wanted) {
    ctx.step("repository_check");
    if (!await ctx.ports.github.repositoryExists(repository)) throw new RehearsalFailure("repository_missing", "create_it_by_hand");
    present++;
  }
  return { present };
}
