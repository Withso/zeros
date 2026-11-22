// Stage provision: the fixture repositories the other stages need and Alpha does not have yet. Only
// Withso/zeros-dev-fixture-* names (guard.ts), each private with one initial commit holding GitHub's Node .gitignore (so
// a seeded .env is ignored); recorded so cleanup removes exactly what this run created unless --keep-fixtures.
import { type StageContext } from "./contract.js";
import { assertRepository } from "./guard.js";
import { check } from "./steps.js";

/** R2's default name, as the owner approved it; `--repository-two` names another fixture. */
export const FIXTURE_TWO = "Withso/zeros-dev-fixture-2";

export async function stageProvision(ctx: StageContext): Promise<Record<string, number>> {
  const wanted = [ctx.repositories.two ?? FIXTURE_TWO];
  // Stage D's two (submodules and a private submodule) are created when D is written, by the names the owner approves.
  let created = 0, present = 0;
  for (const repository of wanted.map(assertRepository)) {
    ctx.step("repository_two");
    if (await ctx.ports.github.repositoryExists(repository)) { present++; continue; }
    // Recorded first: it did not exist, so a lost create response is still removed by cleanup.
    ctx.state.created.repositories.push(repository);
    await ctx.save();
    await ctx.ports.github.createRepository(repository);
    check(await ctx.ports.github.repositoryExists(repository), "repository_created", "not_visible");
    created++;
  }
  ctx.repositories.two ??= FIXTURE_TWO;
  return { created, present };
}
