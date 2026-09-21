import {randomUUID} from "node:crypto";
import pg from "pg";
import {afterAll,beforeAll,describe,expect,it} from "vitest";
import {runMigrations} from "./migrate.js";

const suite=process.env.TEST_DATABASE_URL?describe:describe.skip;
type Plan={"Node Type":string;"Actual Rows":number;"Rows Removed by Filter"?:number;Plans?:Plan[]};
const nodes=(plan:Plan):Plan[]=>[plan,...(plan.Plans??[]).flatMap(nodes)];
suite("browser session authentication query plans",()=>{
  let pool:pg.Pool;
  const prefix=randomUUID();
  beforeAll(async()=>{
    pool=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL,max:2});
    await pool.query("DROP SCHEMA public CASCADE;CREATE SCHEMA public");await runMigrations(pool);
    await pool.query(`INSERT INTO workos_browser_sessions(credential_hash,kind,sealed_session,provider_session_id,provider_sub,
      email,access_token_expires_at,expires_at,revision)
      SELECT digest($1||n::text,'sha256'),'session','encrypted-fixture',$1||n::text,'subject-'||n,
        'fixture-'||n||'@example.test',now()+interval '15 minutes',now()+interval '1 day',1
      FROM generate_series(1,10000)n`,[prefix]);
    await pool.query("ANALYZE workos_browser_sessions");
  });
  afterAll(async()=>{await pool?.end();});
  it("finds a provider session without scanning unrelated browser credentials",async()=>{
    const result=await pool.query(`EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON) SELECT account_user_id,account_revision
      FROM workos_browser_sessions WHERE kind='session' AND provider_session_id=$1`,[prefix+'5000']);
    const plan=nodes(result.rows[0]['QUERY PLAN'][0].Plan as Plan);
    expect(plan[0]!['Actual Rows']).toBe(1);
    expect(Math.max(...plan.map(node=>node['Actual Rows']+(node['Rows Removed by Filter']??0)))).toBeLessThanOrEqual(2);
  });
});
