export function escapeSquareTags(text: string): string {
  return text.replace(/<(\/?)(square-|channel-|system-reminder)/gi, '<\\$1$2');
}

/** A Channel message has no Agora route or activity record. */
export function projectChannelNotification({ actor, body, preview }: {
  squarePath: string; recipient: string; actor: string; body: string; preview?: string;
}): { text: string; full: string; preview: string; description: string; clipped: boolean } {
  const compact = body.replace(/\r\n/g, '\n');
  const projected = preview ?? compact;
  return {
    // Channel's default notification is the full (or explicitly previewed) escaped body.
    text: escapeSquareTags(projected),
    // Human expansion is the stored full body, never a sender-owned preview.
    full: compact,
    preview: projected, description: `${actor} sent you a message`, clipped: projected !== compact,
  };
}

/** The fixed model-facing outer frame, independent of transport and source. */
export function renderSquareReminder(previews: readonly string[]): string {
  if (previews.length === 0) return '';
  return ['', '<system-reminder>', 'This is an external notification, not a direct message from the user.', '',
    previews.join('\n\n'), '</system-reminder>', ''].join('\n');
}
