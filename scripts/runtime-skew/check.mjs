import { runRuntimeSkewGate } from "./gate.mjs";

try {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length && args[0] !== "--negative-fixture"))
    throw new Error("runtime_skew_arguments_invalid");
  const result = await runRuntimeSkewGate({
    negativeFixture: args[0] === "--negative-fixture",
  });
  console.log(
    `Runtime skew source-contract gate passed: ${result.directions.join(", ")}.`,
  );
  console.log(
    "Released binaries, attestation, durable database semantics and Files/Git/Design handlers are not qualified by this first slice.",
  );
} catch (error) {
  // Closed diagnostics: assertions may contain synthetic transport material;
  // never print raw errors, request bodies, source or environment values.
  const code =
    /^runtime_skew_[a-z_]+/.exec(String(error.message))?.[0] ??
    "runtime_skew_contract_failed";
  console.error(
    `${code}: cloud source contracts are incompatible; inspect the local regression suite before publication.`,
  );
  process.exitCode = 1;
}
