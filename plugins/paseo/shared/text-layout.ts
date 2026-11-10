export type TextLine = { top: number; height: number };

/** The edge falls after the last whole text line, even when the nominal limit lands in a block gap. */
export function wholeLineHeight(lines: readonly TextLine[], limit: number): number | undefined {
  return lines.reduce<number | undefined>((cut, line) => {
    const edge = line.top + line.height;
    return edge <= limit && (cut === undefined || edge > cut) ? edge : cut;
  }, undefined);
}
