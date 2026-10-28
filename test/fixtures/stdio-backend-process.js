import fs from 'node:fs';
import { createInterface } from 'node:readline';
import { STDIO_PROTOCOL_VERSION } from '../../dist/square-stdio.js';
import { runSquareStdioServer } from '../../dist/stdio-server.js';

const [mode, root, marker] = process.argv.slice(2);
if (marker) fs.writeFileSync(marker, String(process.pid));
if (mode === 'sqlite') {
  await runSquareStdioServer(root);
} else {
  const lines = createInterface({ input: process.stdin });
  const send = message => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
  lines.on('line', line => {
    const request = JSON.parse(line);
    if (request.method === 'square/open') {
      if (mode === 'malformed') process.stdout.write('not JSON\n');
      else send({ id: request.id, result: { version: mode === 'version' ? 2 : STDIO_PROTOCOL_VERSION, handle: 'square' } });
    } else if (request.method === 'participant') send({ id: request.id, result: request.params.args[0] });
    else if (request.method === 'express') {
      fs.appendFileSync(root, 'express\n');
      process.exit(0); // response lost after dispatch: cannot claim unsent
    } else if (request.method === 'square/close' && mode !== 'stubborn') {
      send({ id: request.id, result: null });
      process.exit(0);
    }
  });
  if (mode === 'stubborn') process.on('SIGTERM', () => {});
}
