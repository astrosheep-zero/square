import { SquareError } from './model.js';
import { withPathOutput } from './presentation.js';
import { coreCompact } from './decisions.js';
import { execute } from './square-application.js';

export interface CompactOptions {
  keep: number;
}

function sidecarPath(squarePath: string): string {
  return squarePath.replace(/\.md$/, '') + '.archive.md';
}

export async function cmdCompact(squarePath: string, opts: CompactOptions): Promise<void> {
  try {
    let archivedCount: number;
    let keptCount: number;
    const archive = sidecarPath(squarePath);

    const committed = await execute<ReturnType<typeof coreCompact>>(squarePath, { type: 'compact', keep: opts.keep, archivePath: archive });
    const result = committed.result;
    archivedCount = result.archived.length;
    keptCount = result.doc.acts.length;

    const summary = ['✓ compacted', `  · archived ${archivedCount!} activities`, `  · kept ${keptCount!} activities`, ...(archivedCount! > 0 ? [`  · sidecar ${archive}`] : [])].join('\n');
    process.stdout.write(withPathOutput(squarePath, summary));
  } catch (err) {
    if (err instanceof SquareError) {
      process.stderr.write(err.message + '\n');
      process.exit(err.code === 'not_found' ? 1 : 2);
    }
    throw err;
  }
}
