import fs from 'node:fs';

const [squarePath] = process.argv.slice(2);
const originalLink = fs.promises.link;

fs.promises.link = async function stopBeforePublication(from, to) {
  process.stdout.write('ready-before-publication\n');
  await new Promise(() => {});
  return originalLink.call(this, from, to);
};

const { Square } = await import('../../dist/index.js');
await Square.build({ path: squarePath, markdown: 'must not publish' });
