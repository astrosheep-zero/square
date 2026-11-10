import type { CardPresentation } from "./card-presentation.ts";

export function reachLabel(reach: CardPresentation["reach"]): string | undefined {
  return reach === "mention" ? "@you" : reach === "attention" ? undefined : reach;
}

/** Calendar days, rather than elapsed hours, keep yesterday correct across DST. */
export function timeLabel(at: number, now = Date.now(), compact = false): string {
  const date = new Date(at), today = new Date(now);
  const day = (value: Date) => `${value.getFullYear()}-${value.getMonth()}-${value.getDate()}`;
  const clock = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  if (day(date) === day(today)) return clock;
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (day(date) === day(yesterday)) return `${compact ? "yest" : "yesterday"} ${clock}`;
  const shortDate = compact
    ? `${String(date.getMonth() + 1).padStart(2, "0")}/${String(date.getDate()).padStart(2, "0")}`
    : date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  return `${shortDate} ${clock}`;
}

/** Only adjacent references from the same origin can form a range. */
export function cardReferences(items: readonly CardPresentation[], originLabel: (origin: string) => string = origin => origin): string {
  const multipleOrigins = new Set(items.map(item => item.origin)).size > 1;
  const runs: { origin: string; ref: string; first?: number; last?: number }[] = [];
  for (const item of items) {
    if (item.ref === undefined) continue;
    const match = /^act\/(\d+)$/.exec(item.ref);
    const index = match ? Number(match[1]) : undefined;
    const previous = runs.at(-1);
    if (index !== undefined && previous?.origin === item.origin && previous.last !== undefined && previous.last + 1 === index) {
      previous.last = index;
    } else runs.push({ origin: item.origin, ref: item.ref, first: index, last: index });
  }
  return runs.map(run => `${multipleOrigins ? `${originLabel(run.origin)} ` : ""}${run.first !== run.last
    ? `act/${run.first}–${run.last}` : run.ref}`).join(", ");
}
