import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function nodeCommandFixture(prefix, source) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
  const script = path.join(root, 'command.cjs');
  fs.writeFileSync(script, source);
  return {
    root,
    bin: process.execPath,
    args: [script],
  };
}
