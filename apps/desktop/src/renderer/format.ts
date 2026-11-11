import { hasRole, type Message, type Participant } from "@matters/core";

// en-GB: "14:05" today, "3 Nov" otherwise.
const time = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit" });
const shortDate = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" });
const shortDateYear = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
});
const full = new Intl.DateTimeFormat("en-GB", {
  weekday: "long",
  day: "numeric",
  month: "long",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

export function listDate(ms: number, now = Date.now()): string {
  const d = new Date(ms);
  const n = new Date(now);
  if (d.toDateString() === n.toDateString()) return time.format(d);
  return d.getFullYear() === n.getFullYear() ? shortDate.format(d) : shortDateYear.format(d);
}

const dayTime = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
});
const dayTimeYear = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

/**
 * "31 Oct, 16:24": the date at the top of an open letter, and beside a source or a quote. A
 * letter from another year says which: "3 Oct 2017, 12:20".
 */
export function letterDate(ms: number, now = Date.now()): string {
  const d = new Date(ms);
  return d.getFullYear() === new Date(now).getFullYear()
    ? dayTime.format(d)
    : dayTimeYear.format(d);
}

export function fullDate(ms: number): string {
  return full.format(new Date(ms));
}

/**
 * Bidirectional controls: they reorder the text around them, so a name can read backwards or hide
 * its end (UAX #9). Zero-width joiners are not here: real names in Persian, Arabic and Indic
 * scripts need them.
 */
const BIDI_CONTROLS = /[\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;
const ADDRESS_SHAPED = /[^\s@<>()[\]"',;:]+@[^\s@<>()[\]"',;:]+/g;

/**
 * What a person is called on screen. The name the sender chose, without bidirectional controls;
 * the address when there is no name. A name that holds an address other than the participant's
 * own is shown as `name <address>`, so the real address is never hidden behind one that looks
 * real. Only for showing: never build a header or a recipient from this text.
 */
export function displayName(p: Participant): string {
  const name = (p.name ?? "").replace(BIDI_CONTROLS, "").trim();
  if (name === "") return p.address;
  const own = p.address.toLowerCase();
  const foreign = (name.match(ADDRESS_SHAPED) ?? []).some(
    (found) => found.replace(/\.+$/, "").toLowerCase() !== own,
  );
  return foreign ? `${name} <${p.address}>` : name;
}

/**
 * Is a message the reader's own? Only when the account's server vouched for the sender, or the
 * message is in the account's Sent or Drafts folder. A message that merely claims the reader's
 * address, with no authentication, is not (ADR 0048).
 */
export function isReallyOwn(m: Pick<Message, "senderAuth" | "mailboxes">): boolean {
  return (
    m.senderAuth === "pass" ||
    hasRole(m.mailboxes ?? 0, "sent") ||
    hasRole(m.mailboxes ?? 0, "drafts")
  );
}

/** The sender of a message: "You" for the reader's own mail, else the sender's `displayName`. */
export function senderName(
  m: Pick<Message, "from" | "senderAuth" | "mailboxes">,
  own: ReadonlySet<string>,
): string {
  return own.has(m.from.address.toLowerCase()) && isReallyOwn(m) ? "You" : displayName(m.from);
}

/** Megabytes as Finder counts them (1 MB is a million bytes), one decimal when it is not whole. */
export function megabytes(bytes: number): string {
  const rounded = Math.round(bytes / 100_000) / 10;
  return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1)} MB`;
}

/** A file's size for a chip: bytes, KB or MB, with one decimal where it helps. */
export function fileSize(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`;
  if (bytes < 1_000_000) return `${Math.round(bytes / 1000)} KB`;
  if (bytes < 1_000_000_000) return megabytes(bytes);
  return `${(Math.round(bytes / 100_000_000) / 10).toFixed(1)} GB`;
}
