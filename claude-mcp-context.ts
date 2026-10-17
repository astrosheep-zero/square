import { createHash, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod/v4';
import { withFileLock } from './file-lock.js';
import { hostLedgerRoot } from './host-ledger-root.js';
import { SquareError } from './model.js';

const LEASE_MS = 10 * 60 * 1000;
const text = z.string().max(4096).refine(value => value.trim().length > 0 && !/[\x00-\x1f\x7f]/u.test(value));
const coordinate = z.object({
  toolUseId: text, sessionId: text, cwd: text.refine(path.isAbsolute), agentId: text.optional(),
});
const record = coordinate.extend({ token: z.string().regex(/^[a-f0-9]{64}$/u), expiresAt: z.number() });
type ClaudeMcpCall = z.infer<typeof coordinate>;
const unavailable = () => new SquareError('unavailable', 'Claude MCP call context unavailable');
const storeRoot = (env: NodeJS.ProcessEnv) => path.resolve(hostLedgerRoot(env), 'claude-mcp-calls');
const callFile = (root: string, id: string) => path.join(root, `${createHash('sha256').update(id).digest('hex')}.json`);

async function readRecord(file: string): Promise<z.infer<typeof record> | undefined> {
  try { return record.parse(JSON.parse(await fs.readFile(file, 'utf8'))); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw unavailable();
  }
}

// Only publishers/cleanup mutate this private transport directory. Readers see an
// immutable record via atomic rename, so they need neither a lock nor housekeeping.
async function mutate<T>(env: NodeJS.ProcessEnv, fn: (root: string) => Promise<T>): Promise<T> {
  const root = storeRoot(env);
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  await fs.chmod(root, 0o700);
  return withFileLock(path.join(root, 'store.lock'), { retryMs: 10, signal: AbortSignal.timeout(2000) }, () => fn(root));
}

export async function beginClaudeMcpCall(input: ClaudeMcpCall, env: NodeJS.ProcessEnv = process.env): Promise<{ token: string }> {
  const parsed = coordinate.safeParse(input);
  if (!parsed.success) throw unavailable();
  return mutate(env, async root => {
    const now = Date.now();
    for (const name of await fs.readdir(root)) {
      if (!/^[a-f0-9]{64}\.json$/u.test(name)) continue;
      const file = path.join(root, name);
      const old = await readRecord(file).catch(() => undefined);
      if (old && old.expiresAt <= now) await fs.unlink(file);
    }
    const file = callFile(root, parsed.data.toolUseId);
    if (await readRecord(file)) throw unavailable();
    const token = randomBytes(32).toString('hex');
    const temporary = path.join(root, `${token}.tmp`);
    try {
      await fs.writeFile(temporary, JSON.stringify({ ...parsed.data, token, expiresAt: now + LEASE_MS }), { flag: 'wx', mode: 0o600 });
      await fs.rename(temporary, file);
    } finally { await fs.rm(temporary, { force: true }); }
    return { token };
  });
}

export async function endClaudeMcpCall(toolUseId: string, token: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  if (!text.safeParse(toolUseId).success || !text.safeParse(token).success) throw unavailable();
  await mutate(env, async root => {
    const file = callFile(root, toolUseId);
    const stored = await readRecord(file);
    if (stored?.toolUseId === toolUseId && stored.token === token) await fs.unlink(file);
  });
}

/** Expiry gates lookup only; an executing tool keeps its captured coordinate. */
export async function readClaudeMcpCall(toolUseId: unknown, env: NodeJS.ProcessEnv = process.env): Promise<ClaudeMcpCall> {
  if (!text.safeParse(toolUseId).success) throw unavailable();
  const stored = await readRecord(callFile(storeRoot(env), toolUseId as string));
  if (!stored || stored.toolUseId !== toolUseId || stored.expiresAt <= Date.now()) throw unavailable();
  return coordinate.parse(stored);
}
