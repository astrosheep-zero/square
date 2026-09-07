import { DatabaseSync } from 'node:sqlite';

const [squarePath, replacement] = process.argv.slice(2);
const database = new DatabaseSync(squarePath);
database.exec('PRAGMA journal_mode = DELETE');
database.exec('BEGIN IMMEDIATE');
database.prepare('UPDATE square_snapshot SET state = ? WHERE id = 1').run(replacement);
process.stdout.write('transaction-open\n');
setInterval(() => {}, 1_000);
