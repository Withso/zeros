import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { beforeAll, describe, expect, it } from 'vitest';

describe('pinned Codex admitted MCP namespace',()=>{
  let results: { label: string; error?: string; inherited?: string; launched?: string | null; threadStarted?: boolean }[];
  beforeAll(async()=>{
    const {stdout}=await promisify(execFile)(process.execPath,['--import','tsx','apps/desktop/src/engine/agents/adapters/codex/__tests__/fixtures/cloud-mcp-probe.mts'],{cwd:process.cwd(),timeout:30000,maxBuffer:1024*1024});
    results=stdout.trim().split('\n').map(line=>JSON.parse(line));
  },35000);
  it('replaces the complete lower-precedence transport',()=>{
    expect(results.find(row=>row.label==='transport replacement')).toMatchObject({threadStarted:true});
    expect(results.find(row=>row.label==='transport replacement')!.error).toBeUndefined();
  });
  it('does not give a higher-precedence replacement the lower source environment',()=>{
    expect(results.find(row=>row.label==='lower layer environment inheritance')!.inherited).toBe('absent');
  });
  it('does not launch a repository server added after the admitted snapshot and native discovery',()=>{
    expect(results.find(row=>row.label==='empty snapshot then repository edit')!.launched).toBeNull();
  });
});
