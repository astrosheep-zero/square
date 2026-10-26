import { SqliteSquare } from './sqlite-square.js';
import { squareLocation, backendConfiguration, parseSquareLocation } from './square-location.js';
import { openStdioSquare } from './square-stdio.js';
import type { SquareBackend } from './square-backend.js';
import type { SquareAtInput, SquareBuildInput, OperationControl } from './square-facade.js';

export type * from './square-facade.js';
export { squareLocation } from './square-location.js';
export { squareClock, createSquareResourceOwner, formatActivityId, parseActivityId, MAX_IDENTITY_SET_SIZE,
  CATCH_DEFAULT_LIMIT, CATCH_MAX_LIMIT, HELD_WAIT_BUDGET_MS, HISTORY_DEFAULT_LIMIT, HISTORY_MAX_LIMIT,
  DEFAULT_LIST_DEPTH, MAX_LIST_DEPTH, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT,
  diagnoseSquare, migrateSquare, discover, inbox } from './sqlite-square.js';

/** The same structural resource regardless of persistence or transport. */
export interface Square extends SquareBackend {}
export const Square = {
  async at(input: SquareAtInput, control?: OperationControl): Promise<Square> {
    const captured = { ...input, cwd: input.cwd ?? process.cwd(), env: { ...(input.env ?? process.env) } };
    const location = squareLocation(captured);
    const selected = parseSquareLocation(location);
    return selected.kind === 'local' ? SqliteSquare.at({ ...captured, path: location }, control)
      : openStdioSquare(location, selected, captured, await backendConfiguration(captured), undefined, control);
  },
  async build(input: SquareBuildInput, control?: OperationControl): Promise<Square> {
    const captured = { ...input, cwd: input.cwd ?? process.cwd(), env: { ...(input.env ?? process.env) } };
    const location = squareLocation(captured);
    const selected = parseSquareLocation(location);
    return selected.kind === 'local' ? SqliteSquare.build({ ...captured, path: location }, control)
      : openStdioSquare(location, selected, captured, await backendConfiguration(captured), {
        markdown: input.markdown, hardCap: input.hardCap, throttlePerMinute: input.throttlePerMinute,
        template: input.template, force: input.force,
      }, control);
  },
  inMemory(input: Omit<SquareBuildInput, 'path' | 'resources'>): Square { return SqliteSquare.inMemory(input); },
};
