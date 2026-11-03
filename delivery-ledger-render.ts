/** Finished card text is preserved verbatim inside one fixed, neutral frame. */
export function renderDeliveryBatch(cards: readonly { readonly text: string }[]): string {
  return cards.length === 0 ? '' : '<delivery-batch>\n' + cards.map(card => card.text).join('\n\n') + '\n</delivery-batch>';
}
