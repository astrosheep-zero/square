import fs from 'node:fs';
import path from 'node:path';

/**
 * The one canonicalizer for square locations.
 *
 * Resolve, then realpath the nearest existing ancestor and rejoin the non-existing
 * suffix: a square that does not exist yet under a symlinked directory still lands
 * on the same identity as the directory it will appear in. Any other read error
 * keeps the plain resolution.
 */
export async function canonicalPath(value: string): Promise<string> {
  let current = path.resolve(value);
  const suffix: string[] = [];
  for (;;) {
    try { return path.join(await fs.promises.realpath(current), ...suffix.reverse()); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return path.resolve(value);
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(value);
      suffix.push(path.basename(current));
      current = parent;
    }
  }
}

/** The synchronous face of {@link canonicalPath}, using the native realpath. */
export function canonicalPathSync(value: string): string {
  let current = path.resolve(value);
  const suffix: string[] = [];
  for (;;) {
    try { return path.join(fs.realpathSync.native(current), ...suffix.reverse()); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return path.resolve(value);
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(value);
      suffix.push(path.basename(current));
      current = parent;
    }
  }
}
