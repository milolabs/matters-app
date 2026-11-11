/**
 * The message list as fixed-height items: day headings and rows. Sizes come from the kind of
 * item, never from measuring the DOM (ADR 0010), so the layout is pure and cheap to rebuild.
 */

/** Keep equal to `h-[68px]` on Row. */
export const ROW_HEIGHT = 68;
/** Keep equal to `h-[34px]` on Heading. */
export const HEAD_HEIGHT = 34;

export type ListItem =
  | { readonly kind: "head"; readonly label: string }
  | { readonly kind: "row"; readonly index: number };

export interface ListLayout {
  readonly items: readonly ListItem[];
  /** Offset of each item from the top of the list, in px. */
  readonly starts: readonly number[];
  /** Item index of each message index. */
  readonly rowItem: readonly number[];
  readonly total: number;
}

const DAY = 86_400_000;
const month = new Intl.DateTimeFormat("en-GB", { month: "long" });
const monthYear = new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric" });

function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * A stable bucket id for the day of `ms` seen from `now`: today, yesterday, the rest of this
 * week, then calendar months. Mail dated in the future counts as today.
 */
export function dayBucket(ms: number, now: number): string {
  const today = startOfDay(now);
  if (ms >= today) return "today";
  if (ms >= today - DAY) return "yesterday";
  // Weeks start on Monday, as in the en-GB dates the list shows.
  const weekday = (new Date(today).getDay() + 6) % 7;
  if (ms >= today - weekday * DAY) return "week";
  const d = new Date(ms);
  return `m${d.getFullYear()}-${d.getMonth()}`;
}

export function bucketLabel(bucket: string, now: number): string {
  if (bucket === "today") return "Today";
  if (bucket === "yesterday") return "Yesterday";
  if (bucket === "week") return "Earlier this week";
  const [year, monthIndex] = bucket.slice(1).split("-").map(Number);
  const d = new Date(year ?? 0, monthIndex ?? 0, 1);
  return d.getFullYear() === new Date(now).getFullYear() ? month.format(d) : monthYear.format(d);
}

/**
 * Lays out `messages` newest first. With `heading`, one heading tops the whole list instead of
 * day headings (search results are not in date order).
 */
export function layoutList(
  messages: readonly { readonly dateMs: number }[],
  now: number,
  heading?: string,
): ListLayout {
  const items: ListItem[] = [];
  const starts: number[] = [];
  const rowItem: number[] = [];
  let y = 0;
  const push = (item: ListItem) => {
    starts.push(y);
    items.push(item);
    y += item.kind === "head" ? HEAD_HEIGHT : ROW_HEIGHT;
  };

  if (heading !== undefined && messages.length > 0) push({ kind: "head", label: heading });
  let bucket = "";
  for (let i = 0; i < messages.length; i++) {
    if (heading === undefined) {
      const b = dayBucket(messages[i]?.dateMs ?? 0, now);
      if (b !== bucket) {
        bucket = b;
        push({ kind: "head", label: bucketLabel(b, now) });
      }
    }
    rowItem.push(items.length);
    push({ kind: "row", index: i });
  }
  return { items, starts, rowItem, total: y };
}

/** The index of the item covering `offset`, by binary search over the starts. */
export function itemAt(layout: ListLayout, offset: number): number {
  const { starts } = layout;
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((starts[mid] ?? 0) <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}
