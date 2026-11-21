import type { CardPresentation } from "./card-presentation.ts";

/** Direct styling follows the typed landing route, never a display label. */
export function isDirectCardReach(reach?: CardPresentation["reach"]): boolean {
  return reach !== undefined && reach !== "attention";
}

function reachLabel(reach?: CardPresentation["reach"], recipient?: string): string | undefined {
  return reach === "mention" ? (recipient ? `@${recipient}` : "mention") : reach === "attention" ? undefined : reach;
}

/** Producer label and directed reach are independent display facts. */
export function activityLabel(reach?: CardPresentation["reach"], recipient?: string, replyTo?: string, label?: string): string {
  const directed = reach === "mention" && recipient ? `→ @${recipient}`
    : reach === "reply" && replyTo ? `reply → ${replyTo}` : reachLabel(reach, recipient);
  return [label, directed].filter(Boolean).join(" · ");
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

/** Display form: the meaningful tail of a path-like origin. */
export function shortOrigin(origin: string): string {
  return origin.split(/[\\/]/).filter(Boolean).at(-1) || origin;
}
