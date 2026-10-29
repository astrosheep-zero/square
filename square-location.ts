import path from 'node:path';
import { SquareError } from './model.js';
import type { SquareLocation } from './square-facade.js';

export function squareLocation(input: SquareLocation): string {
  const selected = input.path ?? (input.env ?? process.env).SQUARE_LOCATION;
  if (selected === undefined || selected.trim() === '') throw new SquareError('invalid_args', 'Square needs a location');
  // Windows roots include drive-relative prefixes such as D:.
  if (path.win32.parse(selected).root === '' && /^[A-Za-z][A-Za-z0-9+.-]*:/.test(selected))
    throw new SquareError('invalid_args', 'Expected a local square artifact path');
  return path.resolve(input.cwd ?? process.cwd(), selected);
}
