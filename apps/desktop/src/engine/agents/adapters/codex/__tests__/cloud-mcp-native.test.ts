import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { beforeAll, describe, expect, it } from 'vitest';

describe('pinned Codex admitted MCP namespace',()=>{
  let results: { label: string; error?: string; inherited?: string; launched?: string | null; threadStarted?: boolean;
    projectSettings?:Record<string,unknown>;projectLaunched?:string|null;skillNames?:string[];trustedCwd?:string;instructionsLoaded?:boolean;instructionsDelivered?:boolean }[];
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
  it('uses captured safe settings despite a mutable provider/auth/MCP project source',()=>{
    const row=results.find(row=>row.label==='immutable safe project projection')!;
    expect(row.error).toBeUndefined();expect(row.threadStarted).toBe(true);
    expect(row.projectSettings).toMatchObject({model_verbosity:'high',model_reasoning_summary:'concise',
      personality:'pragmatic',project_doc_max_bytes:4096,project_doc_fallback_filenames:['TEAM.md']});
    expect(row.projectSettings?.developer_instructions).toContain('safe-project-developer-sentinel');
    expect(JSON.stringify(row.projectSettings)).not.toMatch(/repo-(?:model|provider|profile|endpoint|auth|home|path)-trap|private-state-trap|late-/);
    expect(row.projectLaunched).toBeNull();
    expect(row.trustedCwd).toMatch(/\/repo$/);
  });
  it('keeps native repository skills available with raw project configuration disabled',()=>{
    expect(results.find(row=>row.label==='immutable safe project projection')!.skillNames).toContain('project-safe');
  });
  it('delivers the AGENTS.md sentinel through the native developer channel with raw project trust disabled',()=>{
    for(const label of ['untrusted repository instructions','immutable safe project projection']){
      expect(results.find(row=>row.label===label)!.instructionsLoaded).toBe(false);
      expect(results.find(row=>row.label===label)!.instructionsDelivered).toBe(true);
    }
  });
});
