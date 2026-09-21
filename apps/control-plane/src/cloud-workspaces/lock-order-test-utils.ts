import type pg from "pg";
import {expect} from "vitest";

  // Pause immediately before the service's parent lock. The competing
  // transaction already owns that parent, then asks for the child. This
  // reproduces opposite lock ordering without timing-dependent sleeps.
export async function assertDatabaseLockOrder(pool: pg.Pool, input: {
    parentSql: string; parentId: string; childSql: string; childId: string;
    parentQuery: RegExp;
    action: (controlledPool: pg.Pool) => Promise<unknown>;
  }) {
    let reached!: () => void, proceed!: () => void;
    const atParent = new Promise<void>(resolve => { reached = resolve; });
    const release = new Promise<void>(resolve => { proceed = resolve; });
    let intercepted = false;
    const controlled = new Proxy(pool, { get(target, property) {
      if (property === 'connect') return async () => {
        const client = await target.connect();
        return new Proxy(client, { get(connection, field) {
          if (field === 'query') return async (...args: unknown[]) => {
            const sql = typeof args[0] === 'string' ? args[0] : '';
            if (!intercepted && input.parentQuery.test(sql)) {
              intercepted = true; reached(); await release;
            }
            return Reflect.apply(connection.query, connection, args);
          };
          const value = Reflect.get(connection, field);
          return typeof value === 'function' ? value.bind(connection) : value;
        }});
      };
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    }});
    const blocker = await pool.connect();
    try {
      await blocker.query('BEGIN');
      await blocker.query(input.parentSql, [input.parentId]);
      const service = input.action(controlled);
      // Attach a rejection handler before entering the explicit barrier.
      const result = Promise.allSettled([service]);
      await Promise.race([atParent, service.then(() => { throw new Error('Operation did not acquire its scope lock'); })]);
      const competitor = (async () => {
        try {
          await blocker.query(input.childSql, [input.childId]);
          await blocker.query('COMMIT');
        } catch (error) { await blocker.query('ROLLBACK'); throw error; }
      })();
      const competitorResult = Promise.allSettled([competitor]);
      proceed();
      const outcomes = [...await result, ...await competitorResult];
      expect(outcomes.map(outcome => outcome.status === 'fulfilled' ? 'fulfilled' : (outcome.reason as {code?:string}).code ?? 'rejected')).toEqual(['fulfilled', 'fulfilled']);
    } finally { proceed(); await blocker.query('ROLLBACK'); blocker.release(); }
  }
