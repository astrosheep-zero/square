import type { OperationProgress } from '../square-facade.js';
import { renderWatchForceTakeover, renderWatchReplaceMissing } from '../presentation.js';

export { renderPerceiveOutcome } from '../operation-presentation.js';

export function renderPerceiveProgress(squarePath: string, progress: OperationProgress): string | undefined {
  if (progress.kind !== 'perceive-started' || !progress.replacementRequested) return undefined;
  const options = { squarePath, name: progress.participant };
  return (progress.replaced
    ? renderWatchForceTakeover(options) : renderWatchReplaceMissing(options)) + '\n';
}
