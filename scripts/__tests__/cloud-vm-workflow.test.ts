import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';

const workflow=readFileSync(new URL('../../.github/workflows/zsr-cloud-qualification.yml',import.meta.url),'utf8');
const runbook=readFileSync(new URL('../cloud-workspace-validation/README.md',import.meta.url),'utf8');
describe('protected Linux VM qualification wiring',()=>{
 it('selects VM explicitly and publishes its immutable receipt before snapshot registration',()=>{
  expect(workflow).toMatch(/sandbox_class:[\s\S]*?default: linux-vm/);
  expect(workflow).toContain('DAYTONA_SANDBOX_CLASS: ${{ inputs.sandbox_class }}');
  const publish=workflow.indexOf('pnpm tsx scripts/cloud-workspace-validation/publish-vm-image.ts');
  const bake=workflow.indexOf('pnpm tsx scripts/cloud-workspace-validation/bake-snapshot.ts');
  expect(publish).toBeGreaterThan(0);expect(bake).toBeGreaterThan(publish);
  expect(workflow).toContain('ZEROS_CLOUD_VM_IMAGE_RECEIPT=$state_dir/vm-image-receipt.json');
 });
 it('keeps registry authentication in its protected publisher and removes private state on every outcome',()=>{
  const publisher=workflow.split('- name: Publish immutable Linux VM image')[1]?.split('- name: Qualify exact cloud image')[0];
  expect(publisher).toBeDefined();
  expect(publisher).toContain('secrets.ZSR_CLOUD_VM_REGISTRY_PASSWORD');
  expect(publisher).toContain('--password-stdin');
  expect(publisher).toContain('trap cleanup_registry EXIT');
  expect(publisher).toContain('rm -rf -- "$DOCKER_CONFIG"');
  expect(workflow).toContain('if: always()');
  expect(workflow).toContain('rm -f -- "$ZEROS_CLOUD_VM_IMAGE_RECEIPT"');
 });
 it('verifies the VM producer and consumer and documents the same prerequisite',()=>{
  for(const test of ['cloud-vm-snapshot.test.ts','cloud-snapshot-registration.test.ts'])expect(workflow).toContain(test);
  for(const input of ['DAYTONA_SANDBOX_CLASS','ZEROS_CLOUD_VM_REGISTRY_REPOSITORY','ZEROS_CLOUD_VM_IMAGE_RECEIPT','publish-vm-image.ts'])expect(runbook).toContain(input);
 });
});
