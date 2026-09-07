import { createFileCell } from '../../dist/square-storage.js';
import { express } from '../../dist/landing.js';

const [squarePath, actor, body] = process.argv.slice(2);
const cell = createFileCell(squarePath);
try {
  await express({ cell, clock: Date.now, location: squarePath }, actor, body, { force: true });
} finally {
  await cell.close();
}
