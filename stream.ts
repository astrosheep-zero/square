import fs from 'node:fs/promises';
import { SquareError } from './model.js';
import { observeSquareRevision } from './artifact.js';
import { openSquare, closeOpenSquare } from './open-square.js';
import { streamProjection, streamTailProjection } from './views.js';
import type { OpenOptions, OperationControl, StreamOptions, StreamRecord } from './square-facade.js';

/** Pull-based observation; return interrupts an outstanding pull before awaiting its cleanup. */
export function streamSquare(squarePath: string, options: StreamOptions = {}, control?: OperationControl, openOptions: OpenOptions = {}): AsyncIterable<StreamRecord> {
  return {
    [Symbol.asyncIterator]() {
      const disposal = new AbortController();
      const signal = control?.signal === undefined ? disposal.signal : AbortSignal.any([control.signal, disposal.signal]);
      const iterationControl = { ...control, signal };
      const records = observe();
      return {
        next: () => records.next(),
        return() {
          disposal.abort();
          return records.return(undefined);
        },
      };

      async function* observe(): AsyncGenerator<StreamRecord, void, unknown> {
        try {
          signal.throwIfAborted();
          try { await fs.stat(squarePath); }
          catch {
            signal.throwIfAborted();
            throw new SquareError('unavailable', `Square is unavailable at ${squarePath}`);
          }
          signal.throwIfAborted();
          const start = options.start ?? { kind: 'tail', last: 10 };
          let cursor = start.kind === 'after' ? start.after : -1;
          let initial = start.kind === 'tail' ? start : undefined;
          const observer = await observeSquareRevision(squarePath);
          const close = () => observer.close();
          signal.addEventListener('abort', close, { once: true });
          try {
            signal.throwIfAborted();
            while (true) {
              const generation = observer.generation;
              let baseline: number | null;
              let projection;
              try {
                baseline = await observer.read(signal);
                const square = await openSquare(squarePath, { clock: openOptions.clock, signal }, iterationControl);
                try {
                  projection = initial === undefined
                    ? await streamProjection(square, cursor, options.recipient, iterationControl)
                    : await streamTailProjection(square, initial.last, options.recipient, iterationControl);
                } finally { await closeOpenSquare(square); }
              } catch (error) {
                signal.throwIfAborted();
                if (error instanceof SquareError && error.code === 'invalid_args') throw error;
                // Repair/replacement is a hint, not a reason to scan history on a timer.
                await observer.hinted(generation, Infinity, signal);
                continue;
              }
              for (const item of projection.activities) {
                signal.throwIfAborted();
                yield { seq: item.activity.index, square: squarePath, ...item.activity,
                  ...(item.route === undefined ? {} : { route: item.route }) };
              }
              cursor = projection.cursor;
              initial = undefined;
              if (!projection.hasMore) await observer.changed(baseline, Infinity, signal);
            }
          } finally {
            signal.removeEventListener('abort', close);
            observer.close();
          }
        } catch (error) {
          // Iterator disposal is completion; a caller cancellation still rejects the pull.
          if (!disposal.signal.aborted || control?.signal?.aborted || error !== signal.reason) throw error;
        }
      }
    },
  };
}
