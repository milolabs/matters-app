// `mailto:` links that open a new message in Matters (ADR 0143). Main keeps the links that arrived
// until a composer has really opened with them, one at a time: the mail window asks for the next,
// opens a composer, and then says how it went by the id main gave it. Pure: no Electron, so the
// tests use the same functions.
import { randomUUID } from "node:crypto";
import type { DefaultMailInfo, MailtoPrefill } from "@matters/contracts";
import { parseMailto } from "@matters/core";

/**
 * At most this many links wait for a composer (rule 5), the one being opened among them. A page
 * that fires hundreds gets five drafts, one after the other as each is closed; the rest are
 * dropped.
 */
export const MAILTO_WAITING_MAX = 5;

/**
 * How many times a link's composer may fail to open before the link is dropped (rule 5): one that
 * can never open, say with no account to send from, does not hold the links behind it for ever.
 */
export const MAILTO_TRIES_MAX = 3;

/** Where a link came from: macOS or a second start (outside), or a click in a message (mail). */
export type LinkSource = "outside" | "mail";

/** The link that is first, with the id main knows it by. The id says nothing of the link. */
export interface WaitingLink {
  readonly id: string;
  readonly link: MailtoPrefill;
}

export interface LinkQueue {
  /** Reads a link and keeps it; what it reads, or null when it is not one or nothing more waits. */
  offer(href: string): MailtoPrefill | null;
  /** The oldest link that waits, with its id; it stays first until it is done. Null when none. */
  next(): WaitingLink | null;
  /**
   * The window opened a composer with the first link (`opened` true), and it goes; or could not
   * (false), and it stays first, until it failed `MAILTO_TRIES_MAX` times. Anything but the id of
   * the first link as `next` gave it is ignored. How many links wait after.
   */
  done(id: unknown, opened: unknown): number;
  size(): number;
}

export function createLinkQueue(
  max = MAILTO_WAITING_MAX,
  makeId: () => string = randomUUID,
): LinkQueue {
  const waiting: { id: string; link: MailtoPrefill; given: boolean; failed: number }[] = [];
  return {
    offer(href) {
      if (waiting.length >= max) return null;
      const draft = parseMailto(href);
      if (draft === null) return null;
      waiting.push({ id: makeId(), link: draft, given: false, failed: 0 });
      return draft;
    },
    next() {
      const first = waiting[0];
      if (first === undefined) return null;
      first.given = true;
      return { id: first.id, link: first.link };
    },
    done(id, opened) {
      const first = waiting[0];
      if (first === undefined || !first.given || typeof id !== "string" || id !== first.id) {
        return waiting.length;
      }
      if (opened === true) waiting.shift();
      else if (opened === false && ++first.failed >= MAILTO_TRIES_MAX) waiting.shift();
      return waiting.length;
    },
    size: () => waiting.length,
  };
}

/**
 * The `mailto:` links among a start's arguments (rule 5): what Windows and Linux hand a program
 * for a link, and what a second start from a shell may carry. Nothing else of the arguments is
 * read. At most `MAILTO_WAITING_MAX`.
 */
export function mailtoArguments(argv: readonly string[]): string[] {
  return argv.filter((arg) => /^mailto:/i.test(arg)).slice(0, MAILTO_WAITING_MAX);
}

/** A line for a smoke run's log: how much the link holds, never what (ADR 0143, tests). */
export function linkSummary(draft: MailtoPrefill, source: LinkSource): string {
  return (
    `matters-mailto: a link from ${source} waits ` +
    `(to ${draft.to.length}, cc ${draft.cc.length}, bcc ${draft.bcc.length}, ` +
    `subject ${draft.subject.length}, body ${draft.body.length})`
  );
}

/**
 * The system's side of the default mail app (rule 2): Electron's `app.isDefaultProtocolClient` and
 * `app.setAsDefaultProtocolClient` for `mailto`, or a stand-in in a window test.
 */
export interface MailtoClient {
  isDefault(): boolean;
  /** Asks the system; macOS may ask the person first. Whether the request was taken. */
  makeDefault(): boolean;
}

/**
 * Settings › About's row. Only a build that may ask (a packaged app, or a window test's stand-in)
 * reads the system at all; the rest say they are not offered.
 */
export function defaultMailInfo(client: MailtoClient | null): DefaultMailInfo {
  if (client === null) return { offered: false, isDefault: false };
  let isDefault = false;
  try {
    isDefault = client.isDefault();
  } catch {
    // Not known: the button stays, and pressing it asks again.
  }
  return { offered: true, isDefault };
}

/** The person pressed the button: ask once, then say how things stand. */
export function makeDefaultMail(client: MailtoClient | null): DefaultMailInfo {
  if (client === null) return defaultMailInfo(null);
  try {
    client.makeDefault();
  } catch {
    // The answer below says whether it took.
  }
  return defaultMailInfo(client);
}

/** A window test's stand-in (ADR 0143, tests): not the default until pressed, then the default. */
export function standInMailtoClient(): MailtoClient {
  let on = false;
  return {
    isDefault: () => on,
    makeDefault: () => {
      on = true;
      return true;
    },
  };
}
