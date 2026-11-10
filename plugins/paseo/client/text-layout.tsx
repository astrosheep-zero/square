import { createContext, useContext, useEffect, useId, useRef, type RefObject } from "react";
import { Platform, Text, type TextProps, type View } from "react-native";

import type { TextLine } from "../shared/text-layout";
export const LineMeasurement = createContext<{
  root: RefObject<View | null>;
  geometry: string;
  report: (id: string, lines: TextLine[]) => void;
} | undefined>(undefined);

/** Measure block text against the unscrolled content, including nested lists and quotes. */
export function LineText(props: TextProps) {
  const measurement = useContext(LineMeasurement);
  const id = useId();
  const node = useRef<Text>(null);
  const lines = useRef<{ y: number; height: number }[]>([]);
  const measure = () => {
    if (Platform.OS === "web" || !measurement?.root.current || !node.current) return;
    node.current.measureLayout(measurement.root.current, (_x, y) => {
      measurement.report(id, lines.current.map(line => ({ top: y + line.y, height: line.height })));
    });
  };
  useEffect(measure, [measurement?.geometry]);
  useEffect(() => () => measurement?.report(id, []), [measurement?.report, id]);
  return <Text {...props} ref={node} onLayout={measure} onTextLayout={event => {
    lines.current = event.nativeEvent.lines;
    props.onTextLayout?.(event);
    measure();
  }} />;
}

/** RN Web doesn't emit onTextLayout. DOM ranges give the actual wrapped text rows. */
export function webTextLines(root: View): TextLine[] {
  const element = root as unknown as HTMLElement;
  if (!element.ownerDocument) return [];
  const doc = element.ownerDocument;
  const top = element.getBoundingClientRect().top;
  const walker = doc.createTreeWalker(element, 4 /* SHOW_TEXT */);
  const lines: TextLine[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!node.textContent?.trim()) continue;
    const range = doc.createRange();
    range.selectNodeContents(node);
    for (const rect of Array.from(range.getClientRects())) {
      if (rect.height) lines.push({ top: rect.top - top, height: rect.height });
    }
  }
  return lines;
}
