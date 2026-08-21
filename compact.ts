import { isSquareError } from './model.js';
import { withPathOutput } from './presentation.js';
import { compactSquare } from './square-file-adapter.js';

export interface CompactOptions {
  keep: number;
}

function archivePath(squarePath: string): string {
  return squarePath.replace(/\.square$/, '') + '.archive.square';
}

export async function cmdCompact(squarePath: string, opts: CompactOptions): Promise<void> {
  try {
    let archivedCount: number;
    let keptCount: number;
    const archive = archivePath(squarePath);

    const result = await compactSquare(squarePath, opts.keep, archive);
    archivedCount = result.archived.length;
    keptCount = result.doc.acts.length;

    const summary = ['✓ compacted', `  · archived ${archivedCount!} activities`, `  · kept ${keptCount!} activities`, ...(archivedCount! > 0 ? [`  · archive ${archive}`] : [])].join('\n');
    process.stdout.write(withPathOutput(squarePath, summary));
  } catch (err) {
    if (isSquareError(err)) {
      process.stderr.write(err.message + '\n');
      process.exit(err.code === 'not_found' ? 1 : 2);
    }
    throw err;
  }
}
