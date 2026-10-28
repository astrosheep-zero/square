export const JSON_COMMANDS: ReadonlySet<string> = new Set([
  'join', 'express', 'catch', 'history', 'listen', 'ignore', 'unlisten', 'listening',
  'hold', 'resume', 'done', 'status', 'participants', 'inbox',
]);

/** Serialize the SDK receipt, not its optional presentation or live participant handle. */
export function jsonResult(result: object): string {
  const { observation: _observation, ...data } = result as Record<string, unknown>;
  const participant = data.participant;
  if (participant !== null && typeof participant === 'object' && 'name' in participant
    && 'express' in participant && typeof participant.express === 'function') {
    data.participant = { name: participant.name };
  }
  return `${JSON.stringify(data)}\n`;
}
