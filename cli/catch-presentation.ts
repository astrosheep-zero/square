import type { OperationProgress } from '../square-facade.js';
import { renderWatchForceTakeover, renderWatchReplaceMissing } from '../presentation.js';

export { renderCatchOutcome } from '../operation-presentation.js';

export function renderCatchProgress(squarePath: string, progress: OperationProgress): string | undefined {
  if (progress.kind !== 'catch-started' || !progress.replacementRequested) return undefined;
  const options = { squarePath, name: progress.participant };
  return (progress.replaced
    ? renderWatchForceTakeover(options) : renderWatchReplaceMissing(options)) + '\n';
}
