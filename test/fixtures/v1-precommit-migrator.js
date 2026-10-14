// Runs the real migrate CLI with the conversion transaction held open: the
// interposed COMMIT announces itself to the test and waits to be killed, so a
// crash before COMMIT is a rendezvous rather than a guess about timing.
//
// Only the COMMIT that already carries the format flip inside its transaction is
// intercepted; the read-only preflight's own COMMIT passes straight through.
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

const [cli, squarePath, readyFile] = process.argv.slice(2);
const commit = DatabaseSync.prototype.exec;
let armed = true;

DatabaseSync.prototype.exec = function interposed(sql, ...rest) {
  if (armed && /^commit;?$/i.test(String(sql).trim())) {
    const version = this.prepare('SELECT user_version AS version FROM pragma_user_version').get().version;
    if (version === 2) {
      armed = false;
      fs.writeFileSync(readyFile, 'precommit');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000);
    }
  }
  return commit.call(this, sql, ...rest);
};

process.argv = [process.argv[0], cli, '--location', squarePath, 'migrate'];
await import(pathToFileURL(cli).href);
