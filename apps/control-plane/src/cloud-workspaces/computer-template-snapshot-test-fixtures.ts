import type pg from "pg";
import type { Tx } from "../db.js";
import { computerTemplateBuilderIntent } from "./computer-template-boat.js";
import { computerTemplateBuilderName } from "./computer-template-name.js";
import { prepareBuilderVmOperation } from "./cloud-builder-vm.js";
import { DatabaseBuilderVmOperationStore } from "./cloud-builder-vm-store.js";
import { computerTestAccount } from "./computer-workspace-test-fixtures.js";
import { runtimeBase } from "./runtime-test-fixtures.js";

export async function seedStoppedComputerJournal(pool: pg.Pool, tx: Tx, buildId: string, sandboxId: string) {
  const operationKey = `computer-build:${buildId}`, name = computerTemplateBuilderName(buildId);
  await prepareBuilderVmOperation(new DatabaseBuilderVmOperationStore(pool, computerTestAccount),
    computerTemplateBuilderIntent({ baseImageId: runtimeBase.id, name, operationKey }), async () => runtimeBase.id, tx);
  await tx.query(`UPDATE cloud_builder_vm_operations SET state='archived',sandbox_id=$3,create_dispatched_at=now()
    WHERE account_scope=$1 AND operation_key=$2`, [computerTestAccount, operationKey, sandboxId]);
  await tx.query(`UPDATE cloud_computer_templates SET builder_operation_key=$2,builder_name=$3,allocation_requested_at=now()
    WHERE build_id=$1`, [buildId, operationKey, name]);
}
