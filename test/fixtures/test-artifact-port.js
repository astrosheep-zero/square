import { DatabaseSync } from 'node:sqlite';
import { createSqliteDriver, initializeSqlite, APPLICATION_ID, CURRENT_USER_VERSION } from '../../dist/square-sqlite.js';
import { deriveLanding, landingFacts } from '../../dist/square-domain.js';

/** Arbitrary-history domain fixture. This is test-only and is not SquareArtifactPort. */
export function createTestArtifactPort(locationOrState, initialState) {
  const state = initialState ?? locationOrState;
  const database = new DatabaseSync(':memory:');
  initializeSqlite(database, state);
  database.exec(`PRAGMA application_id=${APPLICATION_ID}; PRAGMA user_version=${CURRENT_USER_VERSION}`);
  let closed = false, version = 0;
  const assertOpen = () => { if (closed) throw new Error('Test artifact fixture is closed'); };
  const run = (write, callback) => {
    assertOpen();
    database.exec(write ? 'BEGIN IMMEDIATE' : 'BEGIN');
    let active = true;
    try {
      const driver = createSqliteDriver(database);
      const guarded = Object.fromEntries(Object.entries(driver).map(([name, member]) => [name,
        typeof member === 'function' ? (...args) => {
          if (!active) throw new Error('Test artifact fixture capability expired');
          return member(...args);
        } : member]));
      const facts = Object.assign({}, guarded, write ? {
        land(activity) {
          if (!active) throw new Error('Test artifact fixture capability expired');
          const index = driver.header().nextActIndex;
          const stored = { ...activity, index };
          driver.applyLanding(deriveLanding(stored, landingFacts(driver, stored)));
          return driver.activity(index);
        },
      } : {});
      const value = callback(facts);
      if (value !== null && (typeof value === 'object' || typeof value === 'function') && typeof value.then === 'function')
        throw new TypeError('Test artifact fixture callbacks must be synchronous.');
      active = false;
      const changed = write && driver.changed;
      const deliveryChanged = write && driver.deliveryChanged;
      if (changed || deliveryChanged)
        database.prepare('UPDATE square_meta SET revision=revision+?,delivery_revision=delivery_revision+? WHERE id=1').run(Number(changed), Number(deliveryChanged));
      database.exec('COMMIT');
      version += Number(changed);
      return { value, version, changed: !!changed };
    } catch (error) {
      active = false;
      try { database.exec('ROLLBACK'); } catch { /* preserve original error */ }
      throw error;
    }
  };
  return {
    read: select => Promise.resolve().then(() => run(false, select)),
    transact: change => Promise.resolve().then(() => run(true, change)),
    revision: () => Promise.resolve().then(() => run(false, facts => facts.header().revision)).then(result => result.value),
    close: async () => { if (!closed) { closed = true; database.close(); } },
  };
}
