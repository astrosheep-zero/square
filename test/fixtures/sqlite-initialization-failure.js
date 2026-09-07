import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const [squarePath] = process.argv.slice(2);
const originalExec = DatabaseSync.prototype.exec;

DatabaseSync.prototype.exec = function failSnapshotInitialization(sql) {
  if (typeof sql === 'string' && sql.includes('CREATE TABLE square_snapshot')) {
    throw new Error('intentional SQLite initialization failure');
  }
  return originalExec.call(this, sql);
};

try {
  const { Square } = await import('../../dist/index.js');
  await Square.build({ path: squarePath, markdown: 'must not publish' });
  throw new Error('build unexpectedly succeeded');
} catch (error) {
  if (!String(error).includes('intentional SQLite initialization failure')) throw error;
  if (fs.existsSync(squarePath)) throw new Error('initialization failure published a destination');
  process.stdout.write('initialization-failed-before-publication\n');
} finally {
  DatabaseSync.prototype.exec = originalExec;
}
