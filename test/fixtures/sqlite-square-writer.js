import { Square } from '../../dist/square-api.js';

const [squarePath, actor, text] = process.argv.slice(2);
const square = await Square.at({ path: squarePath, participant: actor });
try {
  await (await square.participant()).express(text, { force: true });
} finally {
  await square.close();
}
