import { Square } from '../../dist/square-api.js';

const [squarePath, actor, text] = process.argv.slice(2);
const body = { channel: 'test', session: 'square-test-fixture' };
const square = await Square.at({ path: squarePath });
try {
  await (await square.participant(actor, { body })).express(text, { force: true });
} finally {
  await square.close();
}
