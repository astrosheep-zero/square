import { createFileCell } from '../../dist/square-storage.js';
import { express } from '../../dist/square-actions.js';

const [squarePath, actor, body] = process.argv.slice(2);
const cell = createFileCell(squarePath);
try {
  await express({ artifact: cell, clock: Date.now, location: squarePath }, actor, body, { force: true });
} finally {
  await cell.close();
}
