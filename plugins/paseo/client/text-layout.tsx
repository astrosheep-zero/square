import { createContext, useContext, useEffect, useId, useLayoutEffect, useMemo, useReducer, useRef, useSyncExternalStore,
  type RefObject } from "react";
import { Platform, Text, type TextProps, type View } from "react-native";

import { wholeLineHeight, type TextLine } from "../shared/text-layout";
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

export type Fit = { width: number; height: number; cut: number | undefined };
const unmeasured: Fit = { width: 0, height: 0, cut: undefined };

/**
 * Web content size and collapse cut, settled before the browser paints. Mount and content changes measure in a
 * layout effect; later resizes (a hidden pane becoming visible) come from a ResizeObserver feeding
 * useSyncExternalStore, whose re-render is synchronous. onLayout state would land a frame late and the card would jump.
 */
export function useWebFit(root: RefObject<View | null>, limit: number, content: unknown): Fit | undefined {
  const store = useMemo(() => {
    let fit = unmeasured;
    let notify = () => {};
    const measure = () => {
      const element = root.current as unknown as HTMLElement | null;
      if (!element) return false;
      const next = { width: element.offsetWidth, height: element.offsetHeight, cut: wholeLineHeight(webTextLines(root.current!), limit) };
      if (next.width === fit.width && next.height === fit.height && next.cut === fit.cut) return false;
      fit = next;
      return true;
    };
    return {
      measure,
      get: () => fit,
      subscribe(listener: () => void) {
        const element = root.current as unknown as Element | null;
        if (Platform.OS !== "web" || !element || typeof ResizeObserver === "undefined") return () => {};
        notify = listener;
        const observer = new ResizeObserver(() => { if (measure()) notify(); });
        observer.observe(element);
        return () => { observer.disconnect(); notify = () => {}; };
      },
    };
  }, [root, limit]);
  const [, rerender] = useReducer((tick: number) => tick + 1, 0);
  useLayoutEffect(() => { if (Platform.OS === "web" && store.measure()) rerender(); }, [store, content]);
  const fit = useSyncExternalStore(store.subscribe, store.get, store.get);
  return Platform.OS === "web" ? fit : undefined;
}
