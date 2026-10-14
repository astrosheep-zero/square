import { createArtifactPort, createSquareFile, createSquareState, diagnoseSquareFile as diagnoseArtifactFile, writeSquareFile } from './artifact.js';
import type { SquareState } from './model.js';
import type { SquareArtifactPort } from './ports.js';
import { canonicalPath } from './canonical-path.js';
export { createSquareState };
export async function diagnoseSquareFile(location: string): ReturnType<typeof diagnoseArtifactFile> {
    return diagnoseArtifactFile(await canonicalPath(location));
}
/** Explicit fixture import, never a runtime state replacement callback. */
export async function writeSquareSnapshot(location: string, state: SquareState): Promise<void> {
    await writeSquareFile(await canonicalPath(location), state);
}
export async function createSquareSnapshot(location: string, state: SquareState): Promise<boolean> {
    return createSquareFile(await canonicalPath(location), state);
}
/** In-memory SQLite shares row selectors, the domain transition and transaction lifecycle. */
export function createMemoryCell(initial: SquareState): SquareArtifactPort {
    return createArtifactPort(':memory:', initial);
}
export function createFileCell(location: string, signal?: AbortSignal): SquareArtifactPort {
    return createArtifactPort(location, undefined, signal);
}
