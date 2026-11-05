import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod/v4';
import { deliveryLedgerLocation } from './delivery-ledger.js';
import { withFileLock } from './file-lock.js';

const stateSchema = z.object({
  generation: z.string().min(1), promptId: z.string().min(1).optional(),
  stopEpoch: z.string().min(1), consumed: z.boolean(), ended: z.boolean(),
});
export type ClaudeBoundary = z.infer<typeof stateSchema>;

/** Receiver operational facts only: no cards, claims, or payload copies. */
export function claudeBoundaryStore(session: string, env: NodeJS.ProcessEnv) {
  const root = path.join(path.dirname(deliveryLedgerLocation(env)), 'claude-hooks');
  const key = createHash('sha256').update(session).digest('hex');
  const file = path.join(root, `${key}.json`);
  async function mutate<T>(change: (state: ClaudeBoundary | undefined, save: (state: ClaudeBoundary) => Promise<void>) => Promise<T>, signal?: AbortSignal): Promise<T> {
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    await fs.chmod(root, 0o700);
    return withFileLock(path.join(root, `${key}.lock`), { retryMs: 10, signal: signal ?? AbortSignal.timeout(2500) }, async () => {
      let state: ClaudeBoundary | undefined;
      try { state = stateSchema.parse(JSON.parse(await fs.readFile(file, 'utf8'))); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      return change(state, async next => {
        const temporary = `${file}.${randomUUID()}.tmp`;
        try {
          await fs.writeFile(temporary, JSON.stringify(next), { mode: 0o600, flag: 'wx' });
          await fs.rename(temporary, file);
        } finally { await fs.rm(temporary, { force: true }); }
      });
    });
  }
  const matches = (state: ClaudeBoundary | undefined, captured: ClaudeBoundary) => !!state && !state.ended && !state.consumed
    && state.generation === captured.generation && state.promptId === captured.promptId && state.stopEpoch === captured.stopEpoch;
  return {
    async start(attach: () => Promise<string | false>, signal?: AbortSignal): Promise<void> {
      await mutate(async (state, save) => {
        if (state) await save({ ...state, promptId: undefined, ended: true, stopEpoch: randomUUID() });
        const generation = await attach();
        if (generation) await save({ generation, stopEpoch: randomUUID(), consumed: false, ended: false });
      }, signal);
    },
    async end(signal?: AbortSignal): Promise<ClaudeBoundary | undefined> {
      return mutate(async (state, save) => {
        if (state) await save({ ...state, ended: true, stopEpoch: randomUUID() });
        return state;
      }, signal);
    },
    async prompt(promptId: string | undefined, signal?: AbortSignal): Promise<void> {
      await mutate(async (state, save) => {
        if (state && !state.ended) await save({ ...state, promptId, stopEpoch: randomUUID(), consumed: false });
      }, signal);
    },
    capture(promptId: string, signal?: AbortSignal): Promise<ClaudeBoundary | undefined> {
      return mutate(async state => state && !state.ended && !state.consumed && state.promptId === promptId ? state : undefined, signal);
    },
    current(captured: ClaudeBoundary, signal?: AbortSignal): Promise<boolean> { return mutate(async state => matches(state, captured), signal); },
    async consume(captured: ClaudeBoundary, signal?: AbortSignal): Promise<void> {
      await mutate(async (state, save) => {
        if (matches(state, captured)) await save({ ...state!, consumed: true });
      }, signal);
    },
    async watch<T>(signal: AbortSignal, run: () => Promise<T>): Promise<T> {
      await fs.mkdir(root, { recursive: true, mode: 0o700 });
      const lock = path.join(root, `${key}.watch.lock`);
      const handle = await fs.open(lock, 'a', 0o600);
      await handle.close();
      // A newer Stop waits through bounded shutdown; it must not skip a busy lock.
      return withFileLock(lock, { retryMs: 10, signal }, run);
    },
  };
}
