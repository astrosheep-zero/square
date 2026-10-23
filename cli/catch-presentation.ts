import { parseActivityId } from '../square-api.js';
import type { CatchResult, CatchOptions, OperationProgress } from '../square-facade.js';
import {
  participantCommandPrefix, renderAmbientEvent, renderWatchAlreadyActive, renderWatchForceTakeover,
  renderWatchReplaceMissing, renderWatchReplaced, renderWatchStatus, withPathOutput,
} from '../presentation.js';
import { style } from '../tty-style.js';

export function renderCatchProgress(squarePath: string, progress: OperationProgress): string | undefined {
  if (progress.kind !== 'catch-started' || !progress.replacementRequested) return undefined;
  const options = { squarePath, name: progress.participant };
  return (progress.replaced
    ? renderWatchForceTakeover(options) : renderWatchReplaceMissing(options)) + '\n';
}

function continuationCommand(squarePath: string, name: string, options: CatchOptions): string {
  const args = ['--now'];
  if (options.from?.length) args.push('--from', options.from.join(','));
  if (options.mention) args.push('--mention');
  if (options.limit !== undefined) args.push('--limit', String(options.limit));
  return `${participantCommandPrefix(squarePath, name)} catch ${args.join(' ')}`;
}

/** Render settled catch facts; no selection, terminal decisions, receipts or wait machinery. */
export function renderCatchOutcome(
  squarePath: string,
  data: CatchResult,
  options: CatchOptions = {},
): { stdout: string; exitCode: number } {
  const projection = data.observation!;
  const location = projection.location ?? squarePath;
  const name = projection.participant;
  const stop = projection.stop ?? data.status;
  const header = { participantCount: projection.standingCount, held: projection.held };
  const statusOptions = {
    squarePath: location, name, presence: projection.presence,
    showCatchHint: !projection.automaticDeliveryAvailable,
    ownActivityCount: projection.ownActivityCount, hardCap: projection.hardCap,
  };
  if (stop === 'already-active' || stop === 'replaced') {
    return {
      stdout: withPathOutput(location, stop === 'already-active'
        ? renderWatchAlreadyActive(statusOptions) : renderWatchReplaced(statusOptions), header),
      exitCode: stop === 'already-active' ? 1 : 0,
    };
  }
  const rendered = data.activities.map((activity) => renderAmbientEvent(activity, name, {
    now: projection.now, actNumber: projection.sayNumbers[parseActivityId(activity.id)!],
    perception: activity.perception, mention: options.mention ? name : undefined,
  })).filter(Boolean).join('\n\n');
  const remaining = data.remaining === 0 ? ''
    : `○ ${data.remaining} matching ${data.remaining === 1 ? 'activity remains' : 'activities remain'}\n${continuationCommand(location, name, options)}`;
  const terminal = stop === undefined ? '' : renderWatchStatus({
    ...statusOptions, status: stop,
    ...(stop === 'stale' && options.idle !== undefined ? { idleMs: options.idle } : {}),
  });
  const fallback = stop === undefined && !projection.automaticDeliveryAvailable && data.remaining === 0
    ? `${participantCommandPrefix(location, name)} catch --idle 30m\n  stay available for new activity` : '';
  const hint = data.hint === undefined ? '' : style('dim', `· ${data.hint}`);
  return {
    stdout: withPathOutput(location, [terminal, rendered, hint, remaining, fallback].filter(Boolean).join('\n\n'), header),
    exitCode: stop === 'capped' ? 1 : 0,
  };
}
