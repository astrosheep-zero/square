const warning = 'This is an external notification, not a direct message from the user.';

/** Receivers frame finished cards; card text and its whitespace stay verbatim. */
export function renderDeliveryReminder(texts: readonly string[], options: { tagged: boolean }): string {
  if (!texts.length) return '';
  const text = `${warning}\n\n${texts.join('\n\n')}`;
  return options.tagged ? `<system-reminder>\n${text}\n</system-reminder>` : text;
}

export function deliveryFrameOverhead(options: { tagged: boolean }): number {
  return renderDeliveryReminder([''], options).length;
}
