// What the menu of a list row offers (ADR 0056, rule 4), as pure functions so that the words and
// the rules are tested without a page. Keys are shown only where the key does the same thing.
import type { Message, PreparedWork, Thing } from "@matters/core";
import type { FeedbackKind } from "./agent.ts";

export type MailAction =
  | "reply"
  | "replyAll"
  | "forward"
  | "read"
  | "unread"
  | "archive"
  | "delete"
  | "deleteForever"
  | "spam"
  | "move"
  | "fromSender";

export type ThingAction =
  | "reply"
  | "replyAll"
  | "forward"
  | FeedbackKind
  | "prepare"
  | "edit"
  | "archive"
  | "delete"
  | "spam"
  | "move";

export interface MenuItem<A> {
  readonly action: A;
  readonly label: string;
  /** The key that does the same, when one does. */
  readonly key?: string;
  readonly danger?: boolean;
  readonly disabled?: boolean;
  /** Why it is disabled, or what a less obvious item does. */
  readonly title?: string;
}

export interface Menu<A> {
  /** Says how many the menu acts on, when that is more than one. */
  readonly heading?: string;
  readonly sections: readonly (readonly MenuItem<A>[])[];
}

const threadsOf = (rows: readonly { readonly threadId: string }[]) =>
  new Set(rows.map((r) => r.threadId)).size;

export const threadsText = (n: number) => `${n} ${n === 1 ? "thread" : "threads"}`;
export const thingsText = (n: number) => `${n} ${n === 1 ? "thing" : "things"}`;

const SEVERAL_ACCOUNTS = "These are in different accounts, and each has its own folders";

function sameAccount(rows: readonly { readonly accountId: string }[]): boolean {
  return new Set(rows.map((r) => r.accountId)).size <= 1;
}

function moving<D extends "delete" | "deleteForever">(
  rows: readonly { readonly accountId: string }[],
  deletes: D,
): MenuItem<D | "archive" | "spam" | "move">[] {
  const one = sameAccount(rows);
  return [
    { action: "archive", label: "Archive", key: "e" },
    {
      action: deletes,
      label: deletes === "delete" ? "Delete" : "Delete forever",
      key: "⌫",
      danger: deletes !== "delete",
    },
    { action: "spam", label: "Mark as spam", key: "!" },
    {
      action: "move",
      label: "Move to…",
      key: "v",
      ...(one ? {} : { disabled: true, title: SEVERAL_ACCOUNTS }),
    },
  ];
}

export interface MailMenuContext {
  /** The view is Trash: Delete is Delete forever. */
  readonly deletesForever: boolean;
  /** Who the row is from, as a name, when a filter can be written for them. */
  readonly senderName?: string | undefined;
}

/** The menu of one row, or of several: what fits one letter is left out for several. */
export function mailMenu(rows: readonly Message[], context: MailMenuContext): Menu<MailAction> {
  const [only] = rows;
  const seen: MenuItem<MailAction>[] = [];
  if (rows.some((m) => !m.flags.seen))
    seen.push({ action: "read", label: "Mark as read", key: "u" });
  if (rows.some((m) => m.flags.seen)) {
    seen.push({ action: "unread", label: "Mark as unread", key: "u" });
  }
  const moves: MenuItem<MailAction>[] = moving(
    rows,
    context.deletesForever ? "deleteForever" : "delete",
  );
  if (rows.length > 1) {
    return { heading: threadsText(threadsOf(rows)), sections: [seen, moves] };
  }
  const write: MenuItem<MailAction>[] = [
    { action: "reply", label: "Reply", key: "r" },
    { action: "replyAll", label: "Reply all", key: "a" },
    { action: "forward", label: "Forward", key: "f" },
  ];
  const name = context.senderName;
  const helpers: MenuItem<MailAction>[] =
    only !== undefined && name !== undefined
      ? [{ action: "fromSender", label: `Show mail from ${name}` }]
      : [];
  return { sections: [write, seen, moves, helpers].filter((s) => s.length > 0) };
}

const SET_ASIDE: readonly MenuItem<FeedbackKind>[] = [
  {
    action: "closed",
    label: "No reply needed",
    title: "Nothing to answer here. Closes this thing; a new message opens it again",
  },
  { action: "later", label: "Later", title: "Hide it until tomorrow morning" },
  { action: "notImportant", label: "Not important" },
];

/** The agent's work on a thing, for the item that goes with it. */
function workItems(work: PreparedWork | undefined, busy: boolean): MenuItem<ThingAction>[] {
  if (work?.kind === "draft") return [{ action: "edit", label: "Edit draft myself", key: "e" }];
  if (work?.kind === "needs") return [];
  return [
    busy
      ? { action: "prepare", label: "Preparing…", disabled: true }
      : { action: "prepare", label: "Prepare now" },
  ];
}

/** The menu of a thing, or of several. Sending is never here: a draft is read before it goes. */
export function thingMenu(
  things: readonly Thing[],
  preparedOf: (thing: Thing) => PreparedWork | undefined,
  busy: (threadId: string) => boolean,
): Menu<ThingAction> {
  // The keys of Matters are not the keys of the list: `e` edits here, and moving has none.
  const quiet: MenuItem<ThingAction>[] = moving(things, "delete").map(
    ({ key: _key, ...item }) => item,
  );
  const [only] = things;
  if (things.length !== 1 || only === undefined) {
    return { heading: thingsText(things.length), sections: [SET_ASIDE, quiet] };
  }
  const write: MenuItem<ThingAction>[] = [
    { action: "reply", label: "Reply", key: "r" },
    { action: "replyAll", label: "Reply all", key: "a" },
    { action: "forward", label: "Forward", key: "f" },
  ];
  const work = workItems(preparedOf(only), busy(only.threadId));
  return { sections: [write, SET_ASIDE, work, quiet].filter((s) => s.length > 0) };
}
