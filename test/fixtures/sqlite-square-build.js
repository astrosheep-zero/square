import { Square } from '../../dist/square-api.js';

const [squarePath] = process.argv.slice(2);
const square = await Square.build({ path: squarePath, markdown: 'SQLite build race' });
await square.close();
