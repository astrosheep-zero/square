export type TextLine = { top: number; height: number };

/** The edge crosses actual text, even when the nominal limit falls in a block gap. */
export function midLineHeight(lines: readonly TextLine[], limit: number): number | undefined {
  return lines.reduce<number | undefined>((cut, line) => {
    const edge = line.top + line.height * 0.6;
    return edge <= limit && (cut === undefined || edge > cut) ? edge : cut;
  }, undefined);
}
